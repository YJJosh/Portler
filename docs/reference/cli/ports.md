# portler ports

Show the ports assigned to this project's services.

```bash
portler ports
```

Prints the `SERVICE / PORT / URL` table from the current assignments, including the [proxy](/guide/proxy) when configured. A `udp` or `tcp+udp` port shows its [transport](/guide/ports#udp-ports), as in `19132/udp`. See [Ports](/guide/ports) for how assignment works.
