# Mini-projet 2 : application trois niveaux sécurisée et persistante sur k3s

Master DevOps & Cloud Computing, ISET Tozeur. Cours : Orchestration de conteneurs avec Kubernetes (k3s).

Application « Mes tâches » : un gestionnaire de tâches (CRUD) composé de trois niveaux, déployé sur un cluster k3s de trois VM (VMware Workstation) avec configuration externalisée, données persistantes et sauvegardées, ressources maîtrisées et surface d'attaque réduite.

## 1. Architecture

```
                      Utilisateur
                          |
                  Ingress (Traefik)
                    app.k3s.local
                          |
                  Service frontend-svc
                          |
              Deployment frontend (nginx-unprivileged, :8080)
                  /api/ -> api-svc:3000
                          |
                   Service api-svc
                          |
                Deployment api (2 réplicas, Node/Express)
                          |
                    Service db (headless)
                          |
             StatefulSet db (PostgreSQL 16) <--- PVC data-db-0 (1 Gi)
                          ^
                          |
        CronJob db-backup (*/5 min) ---> PVC backup-pvc (1 Gi)

   Namespace tasks : ResourceQuota + LimitRange + RBAC + NetworkPolicies + Pod Security (baseline)
```

Seul le frontend est exposé par l'Ingress. L'API n'est pas accessible de l'extérieur : nginx relaie `/api/` vers `api-svc` à l'intérieur du cluster. La base n'est joignable que par l'API et par le job de sauvegarde.

| Composant | Technologie | Image |
|---|---|---|
| Frontend | React (Vite) servi par nginx-unprivileged | `nourki2003/tasks-frontend` (versionnée, jamais `latest`) |
| API | Node.js / Express, `/health`, `/ready`, logs JSON sur stdout | `nourki2003/tasks-api:1.0.0` |
| Base | PostgreSQL 16 (alpine) | `postgres:16-alpine` |

Toute la configuration passe par des variables d'environnement (`DB_HOST`, `DB_PORT`, `DB_NAME`, `DB_USER`, `DB_PASSWORD`, `API_PORT`). Aucun secret n'est dans le code ni dans les images.

## 2. Structure du dépôt

```
app/
  api/            code + Dockerfile (utilisateur non-root)
  frontend/       code React + Dockerfile (build multi-étapes) + nginx.conf
k8s/
  00-namespace/   Namespace, ResourceQuota, LimitRange
  10-config/      ConfigMap app-config (le Secret réel n'est PAS versionné)
  20-db/          Service headless db, StatefulSet db, PVC et CronJob de sauvegarde
  30-app/         Deployments api et frontend, Services, ConfigMap nginx, Ingress
  40-security/    RBAC (ServiceAccounts, Role, RoleBinding), NetworkPolicies
secret.example.yaml   modèle avec de fausses valeurs
docker-compose.yml    test local (phase 0)
screenshots/          captures d'écran utilisées dans ce document
```

## 3. Prérequis

- Cluster k3s fonctionnel (`kubectl get nodes` : le serveur en `Ready`), avec Traefik et la StorageClass `local-path` (installés par défaut avec k3s). k3s embarque un contrôleur de NetworkPolicies.
- Images publiées sur Docker Hub (option A du §6 de l'énoncé) : les nœuds doivent avoir accès à Internet.
- Sur le poste Windows, une entrée dans `C:\Windows\System32\drivers\etc\hosts` (éditeur lancé en administrateur) :
  ```
  192.168.237.131  app.k3s.local
  ```
  (adresse IP du nœud qui exécute Traefik, ici `k3s-server`).
- Pour reconstruire les images : Docker Desktop (ou Podman).

## 4. Construire et publier les images

```bash
docker login
docker build -t nourki2003/tasks-api:1.0.0      app/api
docker build -t nourki2003/tasks-frontend:1.1.0 app/frontend
docker push nourki2003/tasks-api:1.0.0
docker push nourki2003/tasks-frontend:1.1.0
```

## 5. Ordre de déploiement

À exécuter depuis la racine du dépôt, sur le nœud serveur :

```bash
# 1. Namespace, quota, limites
kubectl apply -f k8s/00-namespace/

# 2. Configuration
kubectl apply -f k8s/10-config/10-configmap.yaml

#    Secret : créé à la main, jamais versionné (voir secret.example.yaml)
read -s -p "Mot de passe base : " PW; echo
kubectl create secret generic db-credentials -n tasks \
  --from-literal=POSTGRES_USER=app_user \
  --from-literal=POSTGRES_PASSWORD="$PW"
unset PW

# 3. Base de données (Service headless + StatefulSet) puis sauvegarde
kubectl apply -f k8s/20-db/
kubectl -n tasks rollout status statefulset/db

# 4. Application (API, frontend, Services, Ingress)
kubectl apply -f k8s/30-app/
kubectl -n tasks rollout status deployment/api
kubectl -n tasks rollout status deployment/frontend

# 5. Sécurité : RBAC puis NetworkPolicies, puis Pod Security
kubectl apply -f k8s/40-security/
kubectl label ns tasks pod-security.kubernetes.io/enforce=baseline --overwrite
```

L'API attend que la base soit prête grâce à un init container (`nc -z db 5432`). L'application est ensuite accessible sur `http://app.k3s.local`.

## 6. Procédure de sauvegarde et de restauration

Le CronJob `db-backup` exécute `pg_dump --clean --if-exists` toutes les 5 minutes (valeur de démonstration) vers `backup-pvc`. Pour déclencher une sauvegarde immédiate :

```bash
kubectl -n tasks create job --from=cronjob/db-backup test-backup
kubectl -n tasks get job test-backup
```

Restauration :

```bash
# 1. Suspendre le CronJob (sinon un nouveau dump écraserait l'état de référence)
kubectl -n tasks patch cronjob db-backup -p '{"spec":{"suspend":true}}'

# 2. Pod utilitaire qui monte le volume de sauvegarde
kubectl apply -f k8s/20-db/tools/backup-reader.yaml
kubectl -n tasks exec backup-reader -- ls -lh /backup

# 3. Recharger le dump voulu (le dump recrée la table)
kubectl -n tasks exec backup-reader -- sh -c 'psql -h db -U app_user -d tasksdb -f /backup/<fichier>.sql'

# 4. Vérifier, puis remettre en route
kubectl -n tasks exec db-0 -- psql -U app_user -d tasksdb -c "SELECT * FROM tasks;"
kubectl -n tasks patch cronjob db-backup -p '{"spec":{"suspend":false}}'
kubectl -n tasks delete pod backup-reader
```

## 7. Exigences E1 à E15 et preuves

### E1 : images versionnées et accessibles à tous les nœuds
Les images sont versionnées (`1.0.0`, `1.1.0`) et publiées sur Docker Hub ; l'image de l'API apparaît avec son tag dans la capture E7/E8 (`nourki2003/tasks-api:1.0.0`).

![Docker Hub](screenshots/16.png)

### E2 : namespace dédié, ResourceQuota et LimitRange
Namespace `tasks`. Le quota limite le namespace (1 CPU et 1 Gi de requests, 2 CPU et 2 Gi de limits, 10 pods, 3 PVC). Le LimitRange impose 50m/64Mi en requests et 250m/256Mi en limits par défaut : un pod de test sans `resources` les reçoit automatiquement.

![Quota et LimitRange](screenshots/3.png)

### E3 : configuration externalisée (ConfigMap et Secret)
Les paramètres non sensibles sont dans le ConfigMap `app-config` (`DB_HOST`, `DB_PORT`, `DB_NAME`, `API_PORT`). Les identifiants sont dans le Secret `db-credentials` (`POSTGRES_USER`, `POSTGRES_PASSWORD`).

![ConfigMap et Secret](screenshots/7.png)

### E4 : aucun secret versionné
`.env` et `k8s/**/secret.yaml` sont dans le `.gitignore`. Seul `secret.example.yaml` (fausses valeurs) est versionné.

> Capture à ajouter : `git status`, `git ls-files | grep -i secret` et `cat .gitignore`.

### E5 : base en StatefulSet avec volume persistant et Service headless
Le StatefulSet `db` utilise un `volumeClaimTemplates` (PVC `data-db-0`, 1 Gi, `local-path`). Le Service `db` est headless (`CLUSTER-IP None`).

![StatefulSet, Services et PVC](screenshots/25.png)

### E6 : persistance des données
Les lignes 3 et 4 sont présentes avant la suppression du pod `db-0` et toujours présentes après son retour (`Running`, âge de quelques secondes), car le nouveau pod réattache le même PVC. Les pods de l'API redémarrent une fois pendant l'arrêt de la base, puis se reconnectent seuls.

![Persistance](screenshots/13.png)

### E7 : démarrage ordonné de l'API
Un init container `wait-for-db` (busybox, boucle `nc -z db 5432`) retarde le démarrage de l'API. Le log montre ensuite la connexion réussie et la création de la table.

![Init container](screenshots/18.png)
![Connexion à la base](screenshots/8.png)

### E8 : requests et limits sur chaque conteneur
L'API a des requests de 50m / 64Mi et des limits de 250m / 128Mi ; l'init container a ses propres valeurs (voir la capture de l'init container ci-dessus). Les autres conteneurs reçoivent leurs valeurs du manifeste ou, à défaut, du LimitRange.

> Capture à ajouter : `kubectl -n tasks get pods -o custom-columns=POD:.metadata.name,REQ_CPU:.spec.containers[*].resources.requests.cpu,REQ_MEM:.spec.containers[*].resources.requests.memory,LIM_CPU:.spec.containers[*].resources.limits.cpu,LIM_MEM:.spec.containers[*].resources.limits.memory`

### E9 : sondes
Readiness sur `/ready` (délai 5 s, période 5 s) et liveness sur `/health` (délai 10 s, période 10 s).

![Sondes](screenshots/19.png)

### E10 : exposition par Ingress
Seul le frontend est exposé, sur `app.k3s.local`. L'application est utilisable depuis le navigateur, y compris après l'application des NetworkPolicies.

![Ingress](screenshots/9.png)
![Application dans le navigateur](screenshots/29.png)

### E11 : sauvegarde planifiée et restauration testée
Le job `test-backup` se termine en `Complete` et le PVC `backup-pvc` est `Bound`. Le test de restauration : la ligne 3 est supprimée (seule la ligne 4 reste), le dump est rechargé avec `psql`, puis les lignes 3 et 4 sont de nouveau présentes.

![Job de sauvegarde](screenshots/10.png)
![Restauration](screenshots/11.png)

### E12 : RBAC
Trois ServiceAccounts applicatifs (`api-sa`, `frontend-sa`, `db-sa`) avec `automountServiceAccountToken: false` : le pod de l'API ne contient aucun jeton (`/var/run/secrets/kubernetes.io/serviceaccount` n'existe pas). Le compte `dev-viewer` est limité au namespace par un Role : `get/list/watch` sur les pods, leurs logs et les services. Il peut lister les pods et lire les logs, mais ne peut ni supprimer un pod ni lire un Secret.

![ServiceAccounts](screenshots/20.png)
![Pods et leur ServiceAccount](screenshots/27.png)
![Vérification des droits](screenshots/12.png)

Limite connue : les pods du CronJob de sauvegarde utilisent encore le ServiceAccount `default`. Un `backup-sa` sans jeton monté est l'amélioration prévue.

### E13 : durcissement des pods
- **API** : `runAsNonRoot`, `runAsUser: 1000`, `allowPrivilegeEscalation: false`, `capabilities.drop: ["ALL"]`, `readOnlyRootFilesystem: true`, profil seccomp `RuntimeDefault`. Le `USER node` du Dockerfile est un nom : Kubernetes exige un UID numérique pour vérifier `runAsNonRoot`.
- **Frontend** : mêmes réglages avec `runAsUser: 101` (nginx-unprivileged) et un `emptyDir` monté sur `/tmp` pour les fichiers d'exécution de nginx.
- **Base** : voir les exceptions justifiées ci-dessous.
- Pod Security : label `enforce=baseline` actif sur le namespace ; l'essai de `restricted` (`--dry-run=server`) liste ce qui échoue.

![securityContext et essai restricted](screenshots/21.png)
![Label baseline](screenshots/24.png)

**Exceptions de durcissement (justifiées)**

| Composant | Exception | Justification |
|---|---|---|
| Base PostgreSQL | Démarrage en root au départ ; capabilities `CHOWN`, `DAC_OVERRIDE`, `FOWNER`, `SETGID`, `SETUID` conservées | L'image prend la propriété du dossier de données sur le volume puis exécute PostgreSQL sous l'utilisateur `postgres` |
| Base PostgreSQL | Pas de `readOnlyRootFilesystem` | PostgreSQL écrit son socket et ses fichiers temporaires hors du volume de données |
| Base, CronJob et pod utilitaire | Ne passent pas le niveau `restricted` (`runAsNonRoot`, seccomp, capabilities) | Mêmes contraintes ; le niveau `baseline` est appliqué et respecté |
| CronJob de sauvegarde | Exécuté en root | Le volume `backup-pvc` créé par `local-path` appartient à root |

### E14 : NetworkPolicies
Une politique `default-deny-ingress` bloque tout le trafic entrant du namespace, puis une politique par flux autorisé.

| Source | Destination | Autorisé | Preuve |
|---|---|---|---|
| Traefik (namespace kube-system) | frontend (8080) | Oui | Application utilisable dans le navigateur |
| frontend | api (3000) | Oui | Les tâches s'affichent et s'enregistrent |
| api | db (5432) | Oui | `nc -zv db 5432` depuis l'API : `open` |
| job de sauvegarde | db (5432) | Oui | Jobs `db-backup` en `Complete` après les politiques |
| frontend | db | Non | `nc` depuis le frontend : exit code 1 |
| autre pod (sans `tier: api`) | db | Non | `pg_isready` depuis un pod de test : `no response` |

![Tests de blocage](screenshots/22.png)
![Sauvegardes après NetworkPolicies](screenshots/28.png)

Limite : ces politiques ne filtrent que le trafic **entrant**. Un pod compromis peut encore initier des connexions sortantes vers n'importe quelle destination. Filtrer l'egress (en autorisant explicitement le DNS) est l'amélioration naturelle.

### E15 : dépôt et documentation
Les manifestes sont rangés par dossier (`00-namespace` à `40-security`) et ce `README.md` décrit les prérequis, l'ordre de déploiement et la procédure de restauration.

## 8. Résilience de l'API

La suppression d'un pod de l'API n'interrompt pas le service : le second réplica continue à répondre pendant que Kubernetes recrée le pod supprimé.

![Suppression d'un pod de l'API](screenshots/14.png)

## 9. Difficultés rencontrées et enseignements

- **Volume lié à un ancien nœud.** Après le renommage des nœuds du cluster, le PVC de la base restait attaché à l'ancien `k3s-worker1` : le pod `db-0` restait `Pending` (« didn't match PersistentVolume's node affinity »). Avec `local-path`, un volume n'est utilisable que sur le nœud qui l'a créé. La solution a été de supprimer le PVC (données de test) et de laisser le StatefulSet en recréer un. Enseignement : un stockage local lie les données à un nœud, ce qui justifie un stockage répliqué ou des sauvegardes hors nœud.
- **Redémarrage de l'API à la perte de la base.** Quand le pod `db-0` est supprimé, l'API redémarre une fois (la bibliothèque `pg` émet un événement d'erreur sur les connexions inactives). Kubernetes la relance et elle se reconnecte seule. On peut l'éviter en gérant cet événement dans le code.
- **Non-root et image de l'API.** `USER node` est un nom, pas un UID : `runAsNonRoot` exige un `runAsUser` numérique dans le `securityContext`.
- **Sauvegarde sur le même nœud que la base.** Elle ne protège pas d'une panne de ce nœud : il faudrait copier les dumps hors du nœud (stockage objet, NFS) ou utiliser un stockage répliqué.