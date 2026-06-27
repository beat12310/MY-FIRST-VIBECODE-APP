import { NextRequest, NextResponse } from 'next/server';
import { runAwsSetup, checkAwsSetupStatus } from '@/services/deployment/aws-setup';
import type { SetupProgress } from '@/services/deployment/aws-setup';

export const maxDuration = 900; // 15 minutes — certificate validation can take 10+ minutes

export async function GET() {
  const status = await checkAwsSetupStatus();
  return NextResponse.json({ ok: true, status });
}

export async function POST(req: NextRequest) {
  const body = await req.json().catch(() => ({}));
  const { action } = body as { action: string };

  if (action === 'status') {
    const status = await checkAwsSetupStatus();
    return NextResponse.json({ ok: true, status });
  }

  if (action === 'run-setup') {
    // Streaming response — send Server-Sent Events so the UI can show progress in real time
    const encoder = new TextEncoder();

    const stream = new ReadableStream({
      async start(controller) {
        const send = (data: object) => {
          controller.enqueue(encoder.encode(`data: ${JSON.stringify(data)}\n\n`));
        };

        try {
          const status = await runAwsSetup((progress: SetupProgress) => {
            send({ type: 'progress', ...progress });
          });

          send({ type: 'complete', status });
        } catch (err) {
          send({
            type: 'error',
            message: err instanceof Error ? err.message : 'Setup failed',
          });
        } finally {
          controller.close();
        }
      },
    });

    return new Response(stream, {
      headers: {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        'Connection': 'keep-alive',
      },
    });
  }

  return NextResponse.json({ error: `Unknown action: ${action}` }, { status: 400 });
}
