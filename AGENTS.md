# Project Instructions: FloodGuard Backend

All agents working within this workspace must adhere to the engineering standards and release standards outlined in this project.

## Quick Checklist for Any Task:
- [ ] **Semantic Versioning (3 Decimals)**: Adhere to [.agents/rules/git_versioning.md](file:///.agents/rules/git_versioning.md) by bumping `package.json` (`vX.Y.Z`), formatting commit messages (`vX.Y.Z - <type>: ...`), and tagging git releases.
- [ ] **Strict User Confirmation for Git (Mandatory)**: ห้ามทำการ `git commit` หรือ `git push` ขึ้น Git เองโดยพลการเด็ดขาด! ต้องรอให้ผู้ใช้สั่ง commit ก่อนเท่านั้น จึงจะทำการ commit และ push ได้
- [ ] **Zero-Emoji Policy**: Zero unicode emojis in LINE OA messages; use clean vector/text representations.
- [ ] **Environment Security**: Never commit `.env` or plain-text credentials to Git; always maintain `.env.example`.
- [ ] **Reliability**: Ensure persistent connections for MQTT and resilient database pooling for PostgreSQL.
