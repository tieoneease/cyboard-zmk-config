import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createHash } from 'node:crypto';

const exec = promisify(execFile);
export async function run(command, args, options = {}) {
  return exec(command, args, { encoding: options.encoding ?? 'utf8', shell: false, windowsHide: true,
    timeout: options.timeout > 0 ? Math.min(options.timeout, 45000) : 45000, maxBuffer: 32 * 1024 * 1024 });
}
export function validateConfig(config) {
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(config.repository)) throw new Error('Invalid configured repository.');
  if (typeof config.branch !== 'string' || !config.branch || config.branch.length > 200 || /[\s~^:?*\[\\]/.test(config.branch) || config.branch.includes('..') || config.branch.startsWith('-')) throw new Error('Invalid configured branch.');
  if (!/^[A-Za-z0-9_-]+\.ya?ml$/.test(config.workflow)) throw new Error('Invalid workflow filename.');
  if (config.artifact !== 'firmware') throw new Error('Expected the ZMK firmware artifact.');
  for (const side of ['left', 'right']) {
    if (!/^imprint_(left|right)-assimilator-bt-zmk\.uf2$/.test(config.files?.[side]) || !config.files[side].startsWith(`imprint_${side}-`)) throw new Error('Invalid per-half firmware filename.');
  }
  return config;
}
export class Github {
  constructor(config, execute = run) { this.config = validateConfig(config); this.execute = execute; }
  async api(path, binary = false) {
    try {
      const { stdout } = await this.execute('gh', ['api', path], { encoding: binary ? 'buffer' : 'utf8' });
      return binary ? Buffer.from(stdout) : JSON.parse(stdout);
    } catch (error) {
      const detail = String(error.stderr || error.message).slice(0, 700);
      throw new Error(`GitHub request failed. Check gh auth status and network access. ${detail}`);
    }
  }
  async check() {
    const { repository, branch, workflow } = this.config;
    const head = await this.api(`repos/${repository}/commits/${encodeURIComponent(branch)}`);
    if (!/^[0-9a-f]{40}$/.test(head.sha)) throw new Error('GitHub returned an invalid commit ID.');
    const runs = await this.api(`repos/${repository}/actions/workflows/${workflow}/runs?branch=${encodeURIComponent(branch)}&per_page=30`);
    if (!Array.isArray(runs?.workflow_runs)) throw new Error('GitHub returned an invalid workflow-runs response.');
    const candidates = runs.workflow_runs.filter(r => r.head_sha === head.sha && r.head_branch === branch && r.head_repository?.full_name === repository && ['push', 'workflow_dispatch'].includes(r.event));
    candidates.sort((a, b) => b.id - a.id || b.run_attempt - a.run_attempt);
    const r = candidates[0];
    return {
      sha: head.sha,
      message: String(head.commit?.message || '').split('\n')[0].slice(0, 240),
      checkedAt: new Date().toISOString(),
      run: r ? { id: r.id, sha: r.head_sha, status: r.status, conclusion: r.conclusion, attempt: r.run_attempt, event: r.event,
        url: `https://github.com/${repository}/actions/runs/${r.id}`, createdAt: r.created_at } : null,
    };
  }
  async rebuild() {
    const { repository, branch, workflow } = this.config;
    await this.execute('gh', ['workflow', 'run', workflow, '--repo', repository, '--ref', branch]);
  }
  async download(current) {
    if (!current.run || current.run.status !== 'completed' || current.run.conclusion !== 'success' || current.run.sha !== current.sha) throw new Error('The current source commit needs a successful build before download.');
    const { repository, branch, artifact: name } = this.config;
    const fresh = await this.api(`repos/${repository}/actions/runs/${current.run.id}`);
    if (!Number.isSafeInteger(fresh.id) || fresh.id !== current.run.id || fresh.head_sha !== current.sha || fresh.head_branch !== branch || fresh.head_repository?.full_name !== repository || fresh.path !== `.github/workflows/${this.config.workflow}` || fresh.status !== 'completed' || fresh.conclusion !== 'success' || !['push', 'workflow_dispatch'].includes(fresh.event)) throw new Error('Build provenance changed or does not match this repository and branch.');
    const result = await this.api(`repos/${repository}/actions/runs/${fresh.id}/artifacts?per_page=100`);
    if (!Array.isArray(result?.artifacts)) throw new Error('GitHub returned an invalid artifacts response.');
    const matches = result.artifacts.filter(a => a.name === name && !a.expired);
    if (matches.length !== 1) throw new Error('Expected exactly one unexpired firmware artifact. Rebuild this commit.');
    const artifact = matches[0];
    if (!Number.isSafeInteger(artifact.id) || artifact.size_in_bytes <= 0 || artifact.size_in_bytes > 16 * 1024 * 1024 || !/^sha256:[0-9a-f]{64}$/.test(artifact.digest || '')) throw new Error('Artifact size or GitHub SHA-256 digest is missing/invalid.');
    if (artifact.workflow_run?.head_sha !== current.sha || artifact.workflow_run?.head_branch !== branch || artifact.workflow_run?.id !== fresh.id) throw new Error('Artifact source does not match the selected build.');
    const zip = await this.api(`repos/${repository}/actions/artifacts/${artifact.id}/zip`, true);
    const digest = `sha256:${createHash('sha256').update(zip).digest('hex')}`;
    if (zip.length !== artifact.size_in_bytes || digest !== artifact.digest) throw new Error('Downloaded artifact does not match GitHub size/SHA-256. Nothing was prepared.');
    return { zip, provenance: { repository, branch, sha: current.sha, runId: fresh.id, runAttempt: fresh.run_attempt, artifactId: artifact.id, digest, downloadedAt: new Date().toISOString() } };
  }
}
