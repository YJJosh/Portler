# portler k8s render

Generate the Kubernetes manifests without applying anything.

```bash
portler k8s render [service...]
```

## Behavior

- Generates the same manifests as [`portler up k8s`](/guide/kubernetes) — Namespace, Deployments, Services, PersistentVolumeClaims — into `.portler/k8s/` and prints them.
- Nothing is applied to the cluster and no images are built or loaded.
- With service names, renders only those services (plus what their manifests need).

Useful for inspecting what Kubernetes mode would do, or for piping into other tooling.
