import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { checkUpstream } from './check-upstream.js';
import { SkillsError } from './errors.js';
import { syncSkills } from './sync.js';
import { validateSkills } from './validate.js';

const USAGE = `usage: skills <sync [--upstream <sha>] | validate | check-upstream>

  sync [--upstream <sha>]   fetch the pinned (or the given immutable) commit, verify every
                            hash, apply patches, validate, then swap skills/ atomically.
                            Set HF_SKILLS_OFFLINE=1 to use the vendored source/ tree.
  validate                  check the pinned source, the generated tree and the patch set.
  check-upstream            report drift against the repository's main branch.`;

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');

function readUpstreamArgument(argv: string[]): string {
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index] as string;
    if (argument === '--upstream') {
      const value = argv[index + 1];
      if (value === undefined || value.startsWith('--')) throw new SkillsError('--upstream needs a commit SHA.');
      return value;
    }
    if (argument.startsWith('--upstream=')) return argument.slice('--upstream='.length);
  }
  return '';
}

function registryEndpointIds(repoRoot: string): string[] {
  const catalog = join(repoRoot, 'packages', 'provider-higgsfield', 'src', 'models', 'registry.json');
  if (!existsSync(catalog)) throw new SkillsError(`The provider catalog is missing at ${catalog}.`);
  const parsed: unknown = JSON.parse(readFileSync(catalog, 'utf8'));
  const models = (parsed as { models?: unknown }).models;
  if (!Array.isArray(models)) throw new SkillsError(`${catalog}: no models array.`);
  return models
    .map((model: unknown) => (model as { endpoint?: unknown }).endpoint)
    .filter((endpoint): endpoint is string => typeof endpoint === 'string');
}

async function main(argv: string[]): Promise<number> {
  const [command] = argv;
  const log = (line: string): void => {
    process.stdout.write(`${line}\n`);
  };

  if (command === 'sync') {
    const result = await syncSkills({
      repoRoot: REPO_ROOT,
      upstream: readUpstreamArgument(argv),
      sourceDir: join(REPO_ROOT, 'packages', 'skills', 'source'),
      patchesDir: join(REPO_ROOT, 'packages', 'skills', 'patches'),
      generatedDir: join(REPO_ROOT, 'packages', 'skills', 'generated'),
      log
    });
    log(`skills: synced ${result.commit} (v${result.version}), ${result.generated.length} skill(s) generated`);
    return 0;
  }

  if (command === 'validate') {
    const skillsDir = join(REPO_ROOT, 'skills');
    const result = await validateSkills({ skillsDir, repoRoot: REPO_ROOT, registryEndpointIds: registryEndpointIds(REPO_ROOT) });
    for (const warning of result.warnings) log(`warn ${warning}`);
    for (const error of result.errors) process.stderr.write(`FAIL ${error}\n`);
    log(`skills: ${result.errors.length} error(s), ${result.warnings.length} warning(s)`);
    return result.errors.length === 0 ? 0 : 1;
  }

  if (command === 'check-upstream') {
    const result = await checkUpstream({ repoRoot: REPO_ROOT, repository: 'higgsfield-ai/skills', log });
    log(
      `pinned ${result.pinnedCommit} / upstream ${result.upstreamHead} (v${result.upstreamVersion}) -> ${
        result.drifted ? 'drifted' : 'in sync'
      }`
    );
    return result.drifted ? 1 : 0;
  }

  process.stderr.write(`${USAGE}\n`);
  return command === undefined || command === '--help' || command === '-h' ? 0 : 2;
}

main(process.argv.slice(2))
  .then((code) => {
    process.exitCode = code;
  })
  .catch((error: unknown) => {
    process.stderr.write(`${error instanceof SkillsError ? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
