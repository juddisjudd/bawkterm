// Bumps package.json, commits, tags vX.Y.Z and pushes; the tag triggers .github/workflows/release.yml.
// Usage: bun run release <patch|minor|major|x.y.z>
import { execSync } from 'node:child_process'
import { readFileSync, writeFileSync } from 'node:fs'

const run = (cmd) => execSync(cmd, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'inherit'] }).trim()
const fail = (message) => {
  console.error(`release: ${message}`)
  process.exit(1)
}

const arg = process.argv[2]
if (!arg) fail('usage: bun run release <patch|minor|major|x.y.z>')
if (run('git status --porcelain')) fail('commit or stash your changes first')
const branch = run('git branch --show-current')
if (branch !== 'main') fail(`release from main, not ${branch}`)

const pkg = JSON.parse(readFileSync('package.json', 'utf8'))
const [major, minor, patch] = pkg.version.split('.').map(Number)
const next =
  arg === 'major' ? `${major + 1}.0.0` : arg === 'minor' ? `${major}.${minor + 1}.0` : arg === 'patch' ? `${major}.${minor}.${patch + 1}` : arg
if (!/^\d+\.\d+\.\d+$/.test(next)) fail(`"${arg}" is not patch, minor, major or x.y.z`)

const rank = (v) => v.split('.').reduce((n, part) => n * 10000 + Number(part), 0)
if (rank(next) < rank(pkg.version)) fail(`${next} is older than the current ${pkg.version}`)

const tag = `v${next}`
if (run(`git tag --list ${tag}`)) fail(`tag ${tag} already exists`)

if (next !== pkg.version) {
  pkg.version = next
  writeFileSync('package.json', JSON.stringify(pkg, null, 2) + '\n')
  run('git add package.json')
  run(`git commit -m "chore(release): ${tag}"`)
}
run(`git tag -a ${tag} -m "bawkterm ${tag}"`)
run(`git push --atomic origin main ${tag}`)

console.log(`Pushed ${tag}. Follow the build with: gh run watch`)
