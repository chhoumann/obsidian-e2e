# Changesets

Add a changeset with:

```sh
vp exec changeset
```

Merging the resulting release PR on `main` makes the publish workflow stage the
new version on npm. It goes public once a maintainer approves it with
`npm stage approve <stage-id>` (2FA), using the stage ID from the workflow log.
