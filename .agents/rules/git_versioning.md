# Rule: Semantic Versioning & Git Release Standard (3-Part Decimal Versioning)

All agents working in this repository must strictly adhere to semantic versioning with 3 decimals / parts (`MAJOR.MINOR.PATCH`, e.g., `1.0.1`, `1.1.0`, `2.0.0`) whenever modifying code and pushing to Git.

---

## 1. Version Format: `X.Y.Z` (3 Decimals)

Follow the standard Semantic Versioning (SemVer 2.0.0):
* **MAJOR (`X.0.0`)**: Significant breaking changes, complete database schema resets, or incompatible API route redesigns.
* **MINOR (`0.Y.0`)**: New features, new API endpoints, new services, or backward-compatible feature additions.
* **PATCH (`0.0.Z`)**: Bug fixes, threshold tuning, query optimizations, dependency updates, or documentation updates.

---

## 2. Mandatory Protocol on Every Git Push

Before any commit is pushed to the remote repository:
1. **Bump `package.json` Version**:
   Update the `"version"` field in `package.json` to the new `X.Y.Z` value.
2. **Standardized Commit Message**:
   Prefix all commit messages with the version number:
   ```bash
   git commit -m "vX.Y.Z - <type>: <concise description>"
   ```
   *Examples:*
   - `v1.0.1 - fix: resolve database connection pooling and support DATABASE_URL`
   - `v1.1.0 - feat: implement bento grid flex message generator and line webhook`
3. **Git Release Tagging**:
   Create a matching Git tag and push it along with the branch:
   ```bash
   git tag vX.Y.Z
   git push origin main --tags
   ```

---

## 3. Strict User Approval Required for Commits & Pushing (Mandatory)

**All agents are strictly prohibited from automatically running `git commit` or `git push` without prior explicit approval from the user.**

* Before running any Git commit or push command:
  1. The agent must prepare and test all changes locally.
  2. The agent must clearly explain the completed changes and wait for the user to explicitly say "commit" or "push".
  3. Under NO circumstances should an agent self-trigger `git commit` or `git push` during autonomous reasoning or without the user's direct instruction.
