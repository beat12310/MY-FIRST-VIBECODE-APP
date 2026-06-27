import { NextRequest, NextResponse } from 'next/server';
import { getAuthUser } from '@/lib/server-auth';
import { DeploymentManager } from '@/services/deployment';
import { slugifyProjectName, buildBrandedUrl } from '@/services/deployment/dns-manager';
import type { VerificationCheck } from '@/services/deployment/types';

export const maxDuration = 300; // 5 min for packaging + upload phase

export async function POST(req: NextRequest) {
  await getAuthUser(req);
  const body = await req.json().catch(() => ({}));
  const { action, projectId, projectName, projectPath, envVars, provider, domain } = body as {
    action: string;
    projectId?: string;
    projectName?: string;
    projectPath?: string;
    envVars?: Record<string, string>;
    provider?: string;
    domain?: string;
  };

  const mgr = DeploymentManager.getInstance();

  // ── deploy ────────────────────────────────────────────────────────────────────
  // Packages + uploads + starts Amplify build. Returns immediately with
  // status='building'. Client should then connect to /api/deploy?action=watch
  // for the full live verification stream.
  if (action === 'deploy') {
    if (!projectId || !projectName || !projectPath) {
      return NextResponse.json({ error: 'projectId, projectName, and projectPath are required' }, { status: 400 });
    }

    try {
      const record = await mgr.deploy({
        projectId,
        projectName,
        projectPath,
        envVars,
        provider: provider as 'amplify' | undefined,
      });

      return NextResponse.json({
        ok: true,
        deployment: {
          deploymentId: record.deploymentId,
          projectId:    record.projectId,
          status:       record.status,
          brandedUrl:   record.brandedUrl,
          slug:         record.slug,
          provider:     record.provider,
          startedAt:    record.startedAt,
        },
        message: `Build started — ${record.projectName} will be live at ${record.brandedUrl}`,
      });
    } catch (err) {
      return NextResponse.json({
        ok: false,
        error: err instanceof Error ? err.message : 'Deployment failed',
      }, { status: 500 });
    }
  }

  // ── watch (SSE) ───────────────────────────────────────────────────────────────
  // Streams the full deployment lifecycle as Server-Sent Events:
  //   build status polls → domain AVAILABLE wait → verification checks → live/failed
  //
  // Event types:
  //   { type: 'status',       status, statusDetail, brandedUrl }
  //   { type: 'verification', check: VerificationCheck }
  //   { type: 'complete',     deployment: DeploymentRecord }
  //   { type: 'error',        message }
  if (action === 'watch') {
    if (!projectId) {
      return NextResponse.json({ error: 'projectId required' }, { status: 400 });
    }

    const encoder = new TextEncoder();
    const stream = new ReadableStream({
      async start(controller) {
        const send = (data: object) => {
          try { controller.enqueue(encoder.encode(`data: ${JSON.stringify(data)}\n\n`)); } catch { /* closed */ }
        };

        try {
          const final = await mgr.pollUntilLive(
            projectId,
            // onUpdate — status changes
            (record) => {
              send({
                type:         'status',
                status:       record.status,
                statusDetail: record.statusDetail ?? '',
                brandedUrl:   record.brandedUrl,
                errorMessage: record.errorMessage,
              });
            },
            // onVerification — individual check results
            (verCheck: VerificationCheck) => {
              send({ type: 'verification', check: verCheck });
            },
          );

          if (final) {
            send({ type: 'complete', deployment: final });
          } else {
            send({ type: 'error', message: 'Deployment record not found' });
          }
        } catch (err) {
          send({ type: 'error', message: err instanceof Error ? err.message : 'Deployment watch failed' });
        } finally {
          controller.close();
        }
      },
    });

    return new Response(stream, {
      headers: {
        'Content-Type':  'text/event-stream',
        'Cache-Control': 'no-cache',
        'Connection':    'keep-alive',
      },
    });
  }

  // ── status ────────────────────────────────────────────────────────────────────
  if (action === 'status') {
    if (!projectId) return NextResponse.json({ error: 'projectId required' }, { status: 400 });

    try {
      const record = await mgr.refreshStatus(projectId);
      if (!record) return NextResponse.json({ error: 'Deployment not found' }, { status: 404 });
      return NextResponse.json({ ok: true, deployment: record });
    } catch (err) {
      return NextResponse.json({ ok: false, error: String(err) }, { status: 500 });
    }
  }

  // ── verify ────────────────────────────────────────────────────────────────────
  // Re-runs only the live verification phase on an existing deployment (no rebuild).
  // Useful when a deployment is marked 'failed' due to a transient DNS/SSL issue.
  if (action === 'verify') {
    if (!projectId) return NextResponse.json({ error: 'projectId required' }, { status: 400 });

    const encoder = new TextEncoder();
    const stream = new ReadableStream({
      async start(controller) {
        const send = (data: object) => {
          try { controller.enqueue(encoder.encode(`data: ${JSON.stringify(data)}\n\n`)); } catch { /* closed */ }
        };
        try {
          const record = await mgr.getRecord(projectId);
          if (!record) { send({ type: 'error', message: 'Deployment not found' }); controller.close(); return; }

          const { runFullVerification } = await import('@/services/deployment/live-verifier');
          const verResult = await runFullVerification({
            appId:      record.providerAppId,
            slug:       record.slug,
            brandedUrl: record.brandedUrl,
            onProgress: (check) => send({ type: 'verification', check }),
          });

          const { updateDeploymentStatus } = await import('@/services/deployment/deployment-store');
          const updated = await updateDeploymentStatus(projectId, {
            status:             verResult.passed ? 'live' : 'failed',
            statusDetail:       verResult.passed
              ? `Live · HTTP ${verResult.httpStatus}`
              : verResult.checks.find(c => c.status === 'fail')?.detail ?? 'Verification failed',
            completedAt:        verResult.completedAt,
            verificationResult: verResult,
          });

          send({ type: 'complete', deployment: updated ?? record });
        } catch (err) {
          send({ type: 'error', message: err instanceof Error ? err.message : 'Verify failed' });
        } finally {
          controller.close();
        }
      },
    });

    return new Response(stream, {
      headers: { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', 'Connection': 'keep-alive' },
    });
  }

  // ── logs ──────────────────────────────────────────────────────────────────────
  if (action === 'logs') {
    if (!projectId) return NextResponse.json({ error: 'projectId required' }, { status: 400 });
    const logs = await mgr.getLogs(projectId);
    return NextResponse.json({ ok: true, logs });
  }

  // ── add-domain ────────────────────────────────────────────────────────────────
  if (action === 'add-domain') {
    if (!projectId || !domain) return NextResponse.json({ error: 'projectId and domain required' }, { status: 400 });
    const normalizedDomain = domain.replace(/^https?:\/\//, '').replace(/^www\./, '').split('/')[0].trim();
    try {
      const record = await mgr.attachCustomDomain(projectId, normalizedDomain);
      if (!record) return NextResponse.json({ error: 'Deployment not found' }, { status: 404 });
      return NextResponse.json({ ok: true, domain: record });
    } catch (err) {
      return NextResponse.json({ ok: false, error: String(err) }, { status: 500 });
    }
  }

  // ── remove-domain ─────────────────────────────────────────────────────────────
  if (action === 'remove-domain') {
    if (!projectId || !domain) return NextResponse.json({ error: 'projectId and domain required' }, { status: 400 });
    const ok = await mgr.detachCustomDomain(projectId, domain);
    return NextResponse.json({ ok });
  }

  // ── refresh-domains ───────────────────────────────────────────────────────────
  if (action === 'refresh-domains') {
    if (!projectId) return NextResponse.json({ error: 'projectId required' }, { status: 400 });
    const record = await mgr.refreshDomainStatuses(projectId);
    return NextResponse.json({ ok: true, deployment: record });
  }

  // ── list ──────────────────────────────────────────────────────────────────────
  if (action === 'list') {
    const all = await mgr.listAll();
    return NextResponse.json({ ok: true, deployments: all });
  }

  // ── destroy ───────────────────────────────────────────────────────────────────
  if (action === 'destroy') {
    if (!projectId) return NextResponse.json({ error: 'projectId required' }, { status: 400 });
    await mgr.destroy(projectId);
    return NextResponse.json({ ok: true });
  }

  // ── preview-slug ──────────────────────────────────────────────────────────────
  if (action === 'preview-slug') {
    if (!projectName) return NextResponse.json({ error: 'projectName required' }, { status: 400 });
    const slug = slugifyProjectName(projectName);
    return NextResponse.json({ ok: true, slug, brandedUrl: buildBrandedUrl(slug) });
  }

  return NextResponse.json({ error: `Unknown action: ${action}` }, { status: 400 });
}

export async function GET(req: NextRequest) {
  const projectId = req.nextUrl.searchParams.get('projectId');
  const mgr = DeploymentManager.getInstance();

  if (projectId) {
    const record = await mgr.getRecord(projectId);
    return NextResponse.json({ ok: true, deployment: record });
  }

  const all = await mgr.listAll();
  return NextResponse.json({ ok: true, deployments: all });
}
