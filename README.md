# studio-workflow

MindfulStudio's shared GitHub Actions workflow. Client design repos (`studio-<client>`, made from
`studio-template`) call it on every save; it builds the designs, checks them, takes screenshots and uploads the
build to https://studio.mindfuldesign.me with a GitHub OIDC token.

```yaml
jobs:
  studio:
    uses: MindfulDesign-me/studio-workflow/.github/workflows/upload.yml@v1
    permissions: { contents: read, id-token: write }
```

Studio accepts uploads only from `.github/workflows/upload.yml` at the tag `v1` (the token's `job_workflow_ref`), so
the `v*` tags are protected: only admins can create, move or delete them. The source lives in
`MindfulDesign-me/mindful-studio` (`workflow/`); change it there, then copy it here and move `v1` on purpose.
It holds no secrets, which is why it can be public (client repos' runners check it out).
