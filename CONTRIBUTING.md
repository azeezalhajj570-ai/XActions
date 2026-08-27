# Contributing to XActions ⚡

Thank you for your interest in contributing to **XActions** — the complete X/Twitter automation platform!

Created by [nich](https://github.com/nirholas) ([@nichxbt](https://x.com/nichxbt))

## 🚀 How to Contribute

### Getting Started

1. **Fork** the repository at [github.com/nirholas/xactions](https://github.com/nirholas/xactions)
2. **Clone** your fork locally
3. **Create a branch** for your feature/fix: `git checkout -b feature/your-feature`
4. **Make changes** and commit with clear messages
5. **Push** and open a Pull Request

### Development Setup

```bash
# Clone your fork
git clone https://github.com/YOUR-USERNAME/xactions.git
cd xactions

# Install dependencies
npm install

# Set up environment
cp .env.example .env

# Initialize database
npx prisma generate
npx prisma db push

# Start development
npm run dev
```

## ✅ Before you open a PR

Three commands. All of them run in CI, so running them locally saves a round
trip:

```bash
npm test           # 1156 tests
npm run docs:check # dead links, stale versions, invented CLI commands
npm run docs:scripts  # only if you added or renamed a browser script
```

`docs:check` is dependency-free and takes about a second. It fails on:

| Problem | Why it is checked |
|---------|-------------------|
| A dead relative link | The first person to notice is a stranger who clicked it and left |
| A dead heading anchor | Same, but harder to spot in review |
| A referenced script that does not exist | Docs telling people to run a deleted file |
| A stale version or MCP tool-count claim | These drifted across 25 files before this existed |
| A documented CLI command that does not exist | The reader assumes they typed it wrong |

If you touched anything that talks to X, also run:

```bash
npm run check:endpoints   # are X's GraphQL query IDs still current?
```

## 📝 Contribution Guidelines

### Code Standards

- ✅ **Small, focused PRs** — easier to review and merge
- ✅ **Clear documentation** — comment your code
- ✅ **No secrets** — never commit credentials or API keys
- ✅ **Test your changes** — ensure nothing breaks
- ✅ **Follow existing patterns** — consistency matters
- ✅ **Never report empty as success** — a scrape that finds nothing must say so
  and say what to do about it. Silently returning `0` or `null` is the single
  most confusing thing this tool can do, and it has happened more than once.

### Types of Contributions Welcome

| Type | Description |
|------|-------------|
| 🐛 Bug Fixes | Fix issues or unexpected behavior |
| ✨ New Features | Add new automation capabilities |
| 📚 Documentation | Improve docs, tutorials, examples |
| 🎨 UI/UX | Enhance dashboard interface |
| 🧪 Tests | Add or improve test coverage |
| 🌐 i18n | Add translations |
| 🔧 Tooling | Improve build, dev experience |

### Pull Request Process

1. Update documentation if adding features
2. Add entries to `docs/` for new functionality
3. Ensure your code follows existing style
4. Link related issues in PR description
5. Wait for review — maintainers aim to respond within 48 hours

## 🏗️ Project Structure

```
xactions/
├── src/              # Core modules
│   ├── automation/   # Automation features
│   └── *.js          # Main scripts
├── api/              # Backend API routes
├── dashboard/        # Frontend UI
├── docs/             # Documentation
├── prisma/           # Database schema
└── bin/              # CLI entry point
```

## 🐛 Reporting Issues

When filing an issue, please include:

- **Clear title** describing the problem
- **Steps to reproduce** the issue
- **Expected vs actual** behavior
- **Screenshots** if applicable
- **Environment** (browser, Node version, etc.)

## 💬 Questions?

- Open a [GitHub Issue](https://github.com/nirholas/xactions/issues)
- Tweet [@nichxbt](https://x.com/nichxbt)

## 📄 License

By contributing, you agree that your contributions will be licensed under the Apache 2.0 License.

### Borrowing from other projects

We learn from other open source projects, and we do it by their rules. Before
you bring anything in from elsewhere, check the upstream LICENSE file itself,
not the README's claim:

- **MIT, BSD, ISC, Apache-2.0, Unlicense, CC0**: you may adapt the code. Keep the
  upstream copyright and licence notice in the file you put it in, and add a row
  to [THIRD-PARTY-NOTICES.md](THIRD-PARTY-NOTICES.md).
- **GPL, LGPL, AGPL, SSPL, MPL, CC-BY-SA, or no LICENSE file at all**: ideas only.
  Read it, understand the mechanism, write your own. Do not paste a line.

Endpoint paths, query IDs, header names and rate-limit numbers are observations
of X's behaviour rather than someone's creative work, so those can be recorded
from any source. Matching a public API's shape is fine everywhere too. When in
doubt, add the dependency instead of copying it.

---

**Thank you for helping make XActions better!** ⚡

## Code of Conduct

Please read and follow our [Code of Conduct](CODE_OF_CONDUCT.md).
