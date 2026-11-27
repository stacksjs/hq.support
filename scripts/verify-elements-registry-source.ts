import assert from 'node:assert/strict'
import { appendFile, mkdir } from 'node:fs/promises'
import { resolve } from 'node:path'
import { assertElementsCiRun } from './verify-elements-ci'

interface SourceInput { repository: string, sourceSha: string, verifierSha: string, runId: string, version: string }
interface PublicationInput extends SourceInput { archiveSha256?: string }
interface SourceRun {
  id: number
  repository: { id: number, full_name: string }
  head_repository: { id: number, full_name: string }
}
interface SourceArtifact {
  id: number
  name: string
  expired: boolean
  size_in_bytes: number
  workflow_run: { id: number, repository_id: number, head_repository_id: number, head_branch: string, head_sha: string }
}

export async function verifyElementsRegistrySource(input: SourceInput, read: (path: string) => Promise<unknown>) {
  const { repository, sourceSha, verifierSha, runId, version } = input
  assert.equal(repository, 'stacksjs/hq.support'); assert.match(sourceSha, /^[a-f0-9]{40}$/); assert.match(verifierSha, /^[a-f0-9]{40}$/)
  assert.match(runId, /^[1-9]\d*$/); assert.ok(Number.isSafeInteger(Number(runId))); assert.match(version, /^0\.1\.0-alpha\.\d+$/)
  const run = await read(`/actions/runs/${runId}`) as SourceRun
  assertElementsCiRun(run, repository, sourceSha)
  assert.equal(run.id, Number(runId)); assert.ok(Number.isSafeInteger(run.repository.id) && run.repository.id > 0); assert.equal(run.head_repository.id, run.repository.id)
  const artifacts = await read(`/actions/runs/${runId}/artifacts?per_page=100`) as { total_count: number, artifacts: SourceArtifact[] }
  assert.equal(artifacts.total_count, artifacts.artifacts.length, 'All source-run artifacts must be inspected')
  const matches = artifacts.artifacts.filter(artifact => artifact.name === `support-elements-${sourceSha}`)
  assert.equal(matches.length, 1, 'Source CI must own exactly one matching candidate')
  const artifact = matches[0]!
  assert.equal(artifact.expired, false); assert.ok(Number.isSafeInteger(artifact.id) && artifact.id > 0); assert.ok(artifact.size_in_bytes > 0)
  assert.deepEqual(artifact.workflow_run, { id: Number(runId), repository_id: run.repository.id, head_repository_id: run.repository.id, head_branch: 'main', head_sha: sourceSha }, 'Artifact ownership must match the original source main CI run')
  return { version, sourceSha, verifierSha, sourceCiRunId: runId, sourceCiUrl: `https://github.com/${repository}/actions/runs/${runId}`, artifactId: artifact.id, artifactName: artifact.name }
}

export async function verifyElementsPublicationSource(input: PublicationInput, read: (path: string) => Promise<unknown>) {
  const { sourceSha, verifierSha, archiveSha256 } = input
  if (sourceSha !== verifierSha || archiveSha256)
    assert.match(archiveSha256 ?? '', /^[a-f0-9]{64}$/, 'Historical publication requires the reviewed archive SHA-256.')
  const proof = await verifyElementsRegistrySource(input, read)
  if (sourceSha !== verifierSha) {
    const ancestry = await read(`/compare/${sourceSha}...${verifierSha}?per_page=1`) as { status: string, base_commit?: { sha: string }, merge_base_commit?: { sha: string } }
    assert.equal(ancestry.status, 'ahead', 'The publication workflow must descend from the historical source.')
    assert.equal(ancestry.base_commit?.sha, sourceSha)
    assert.equal(ancestry.merge_base_commit?.sha, sourceSha)
  }
  return proof
}

if (import.meta.main) {
  assert.equal(process.env.GITHUB_REF, 'refs/heads/main')
  const token = process.env.GITHUB_TOKEN || ''
  assert.ok(token, 'A read-only Actions token is required to inspect the source candidate')
  const repository = process.env.GITHUB_REPOSITORY || ''
  const verify = process.argv.includes('--publication') ? verifyElementsPublicationSource : verifyElementsRegistrySource
  const proof = await verify({ repository, sourceSha: process.env.SUPPORT_ELEMENTS_SOURCE_SHA || '', verifierSha: process.env.GITHUB_SHA || '', runId: process.env.SUPPORT_ELEMENTS_CI_RUN || '', version: process.env.SUPPORT_ELEMENTS_VERSION || '', archiveSha256: process.env.SUPPORT_ELEMENTS_ARCHIVE_SHA256 }, async path => {
    const response = await fetch(`https://api.github.com/repos/${repository}${path}`, { headers: { Accept: 'application/vnd.github+json', Authorization: `Bearer ${token}`, 'X-GitHub-Api-Version': '2022-11-28' }, redirect: 'error', signal: AbortSignal.timeout(15000) })
    assert.ok(response.ok, `GitHub source gate returned HTTP ${response.status}`)
    return await response.json()
  })
  const head = Bun.spawnSync(['git', 'rev-parse', 'HEAD'], { stdout: 'pipe', stderr: 'pipe' })
  assert.equal(head.exitCode, 0); assert.equal(head.stdout.toString().trim(), proof.verifierSha, 'Execute the checked-out verifier revision, never the historical source code')
  const directory = resolve(import.meta.dir, '../storage/framework/runtime/support-elements-readback')
  await mkdir(directory, { recursive: true })
  await Bun.write(resolve(directory, 'source-report.json'), JSON.stringify(proof, null, 2) + '\n')
  if (process.env.GITHUB_OUTPUT) await appendFile(process.env.GITHUB_OUTPUT, `artifact_id=${proof.artifactId}\n`)
  console.info(JSON.stringify(proof, null, 2))
}
