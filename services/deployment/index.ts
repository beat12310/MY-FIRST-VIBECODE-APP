/**
 * DeploymentManager — central orchestrator for DWOMOH Vibe Code hosting
 *
 * Usage:
 *   const mgr = DeploymentManager.getInstance();
 *   const record = await mgr.deploy({ projectId, projectName, slug, projectPath });
 *   await mgr.pollUntilLive(record.projectId, (r) => console.log(r.status));
 */

import type {
  DeployConfig,
  DeploymentProvider,
  DeploymentRecord,
  DeployProviderName,
  CustomDomainRecord,
  VerificationCheck,
} from './types';
import { AmplifyProvider } from './providers/amplify-provider';
import { slugifyProjectName, buildBrandedUrl } from './dns-manager';
import {
  saveDeploymentRecord,
  getDeploymentRecord,
  updateDeploymentStatus,
  listDeploymentRecords,
  deleteDeploymentRecord,
} from './deployment-store';
import { runFullVerification, diagnoseVerificationFailure } from './live-verifier';

// Registry of all available deployment providers
const PROVIDERS: Record<DeployProviderName, DeploymentProvider> = {
  amplify: new AmplifyProvider(),
  // Future providers — implement DeploymentProvider to add more:
  vercel: createStubProvider('vercel', 'Vercel'),
  netlify: createStubProvider('netlify', 'Netlify'),
  railway: createStubProvider('railway', 'Railway'),
  cloudflare: createStubProvider('cloudflare', 'Cloudflare Pages'),
};

function createStubProvider(name: DeployProviderName, displayName: string): DeploymentProvider {
  const notImplemented = () => Promise.reject(new Error(`${displayName} provider not yet implemented`));
  return {
    name,
    displayName,
    deploy: notImplemented,
    getStatus: notImplemented,
    getLogs: notImplemented,
    attachDomain: notImplemented,
    detachDomain: notImplemented,
    destroy: notImplemented,
  };
}

export class DeploymentManager {
  private static instance: DeploymentManager;

  static getInstance(): DeploymentManager {
    if (!this.instance) this.instance = new DeploymentManager();
    return this.instance;
  }

  getProvider(name: DeployProviderName = 'amplify'): DeploymentProvider {
    return PROVIDERS[name];
  }

  /** Deploy a project and persist the record. Returns immediately — app builds async on Amplify. */
  async deploy(opts: {
    projectId: string;
    projectName: string;
    projectPath: string;
    envVars?: Record<string, string>;
    provider?: DeployProviderName;
  }): Promise<DeploymentRecord> {
    const providerName = opts.provider ?? 'amplify';
    const provider = this.getProvider(providerName);
    const slug = slugifyProjectName(opts.projectName);
    const brandedUrl = buildBrandedUrl(slug);

    const config: DeployConfig = {
      projectId: opts.projectId,
      projectName: opts.projectName,
      slug,
      projectPath: opts.projectPath,
      envVars: opts.envVars,
      provider: providerName,
    };

    const result = await provider.deploy(config);

    const record: DeploymentRecord = {
      deploymentId: result.deploymentId,
      projectId: opts.projectId,
      projectName: opts.projectName,
      slug,
      provider: providerName,
      providerAppId: result.providerAppId,
      providerUrl: result.providerUrl,
      brandedUrl,
      status: result.status,
      startedAt: result.startedAt,
      customDomains: [],
    };

    await saveDeploymentRecord(record);
    return record;
  }

  /** Refresh the deployment status from the provider and persist it */
  async refreshStatus(projectId: string): Promise<DeploymentRecord | null> {
    const record = await getDeploymentRecord(projectId);
    if (!record) return null;
    if (record.status === 'live' || record.status === 'failed') return record;

    const provider = this.getProvider(record.provider);
    const status = await provider.getStatus(record.providerAppId, record.deploymentId);

    const updates: Partial<DeploymentRecord> = { status: status.status };
    if (status.completedAt) updates.completedAt = status.completedAt;
    if (status.errorMessage) updates.errorMessage = status.errorMessage;

    return updateDeploymentStatus(projectId, updates);
  }

  /**
   * Full deployment lifecycle: wait for build → wait for domain AVAILABLE →
   * deep verify (DNS + HTTPS + HTTP 200 + page crawl) → mark 'live'.
   *
   * Never marks 'live' until the branded URL returns HTTP 200 and the homepage
   * crawl passes. Auto-repairs CNAME issues during the domain wait phase.
   *
   * @param onUpdate     called on every meaningful status change
   * @param onVerification called for each verification check result
   * @param timeoutMs    max total wait (default 30 minutes)
   */
  async pollUntilLive(
    projectId: string,
    onUpdate?: (record: DeploymentRecord) => void,
    onVerification?: (check: VerificationCheck) => void,
    timeoutMs = 30 * 60 * 1000,
  ): Promise<DeploymentRecord | null> {
    const start = Date.now();

    // ── Phase 1: Wait for Amplify build to SUCCEED ──────────────────────────
    while (Date.now() - start < timeoutMs) {
      const record = await this.refreshStatus(projectId);
      if (!record) return null;
      onUpdate?.(record);

      if (record.status === 'failed') return record;

      // Build done — move to verification phases
      if (record.status === 'live' || record.status === 'building') {
        // If the provider reported 'live' (build SUCCEED), transition to verifying
        if (record.status === 'live') break;
      }

      // Still building (pending / uploading / building)
      await new Promise(r => setTimeout(r, 15_000));
    }

    // Re-read after build loop
    let record = await getDeploymentRecord(projectId);
    if (!record) return null;

    // Mark configuring_domain before domain wait
    record = await updateDeploymentStatus(projectId, {
      status: 'configuring_domain',
      statusDetail: `Waiting for ${record.slug}.${process.env.DWOMOH_BRANDED_DOMAIN || 'dwomohvibe.com'} to become live…`,
    }) ?? record;
    onUpdate?.(record);

    // ── Phase 2 + 3: Deep verification (domain → DNS → HTTPS → HTTP → crawl) ─
    const remaining = timeoutMs - (Date.now() - start);
    const verResult = await runFullVerification({
      appId:            record.providerAppId,
      slug:             record.slug,
      brandedUrl:       record.brandedUrl,
      domainTimeoutMs:  Math.min(remaining * 0.75, 20 * 60 * 1000),
      httpTimeoutMs:    Math.min(remaining * 0.25, 10 * 60 * 1000),
      onProgress: (verCheck) => {
        onVerification?.(verCheck);
        // Emit live status updates during verification
        if (verCheck.status === 'warning') {
          updateDeploymentStatus(projectId, { statusDetail: verCheck.detail }).catch(() => {});
        }
      },
    });

    if (verResult.passed) {
      const final = await updateDeploymentStatus(projectId, {
        status: 'live',
        statusDetail: `Live · HTTP ${verResult.httpStatus} · "${verResult.pageTitle ?? 'OK'}"`,
        completedAt: verResult.completedAt,
        verificationResult: verResult,
      });
      onUpdate?.(final ?? record);
      return final;
    }

    // ── Verification failed — diagnose, log, mark failed ──────────────────
    const { rootCause, recommendation, autoRepairPossible } = diagnoseVerificationFailure(verResult);
    const errorMessage = `Verification failed: ${rootCause}. ${recommendation}`;

    const failed = await updateDeploymentStatus(projectId, {
      status: 'failed',
      statusDetail: rootCause,
      errorMessage,
      completedAt: new Date().toISOString(),
      verificationResult: verResult,
    });
    onUpdate?.(failed ?? record);
    return failed;
  }

  /** Attach a custom domain (e.g., phonecarmarket.com) to a deployed project */
  async attachCustomDomain(projectId: string, domain: string): Promise<CustomDomainRecord | null> {
    const record = await getDeploymentRecord(projectId);
    if (!record) return null;

    const provider = this.getProvider(record.provider);
    const domainRecord = await provider.attachDomain(record.providerAppId, domain);

    const existing = record.customDomains.findIndex(d => d.domain === domain);
    if (existing >= 0) {
      record.customDomains[existing] = domainRecord;
    } else {
      record.customDomains.push(domainRecord);
    }

    await updateDeploymentStatus(projectId, { customDomains: record.customDomains });
    return domainRecord;
  }

  /** Remove a custom domain from a deployed project */
  async detachCustomDomain(projectId: string, domain: string): Promise<boolean> {
    const record = await getDeploymentRecord(projectId);
    if (!record) return false;

    const provider = this.getProvider(record.provider);
    await provider.detachDomain(record.providerAppId, domain);

    const domains = record.customDomains.filter(d => d.domain !== domain);
    await updateDeploymentStatus(projectId, { customDomains: domains });
    return true;
  }

  /** Refresh the status of all custom domains for a project (from the provider) */
  async refreshDomainStatuses(projectId: string): Promise<DeploymentRecord | null> {
    const record = await getDeploymentRecord(projectId);
    if (!record || record.customDomains.length === 0) return record;

    const provider = this.getProvider(record.provider) as AmplifyProvider;
    if (!('getDomainStatus' in provider)) return record;

    const updated: CustomDomainRecord[] = await Promise.all(
      record.customDomains.map(async (d) => {
        const st = await (provider as AmplifyProvider).getDomainStatus(record.providerAppId, d.domain);
        return { ...d, status: st.status as CustomDomainRecord['status'], dnsRecords: st.dnsRecords };
      })
    );

    return updateDeploymentStatus(projectId, { customDomains: updated });
  }

  /** Get the deployment record for a project */
  getRecord(projectId: string): Promise<DeploymentRecord | null> {
    return getDeploymentRecord(projectId);
  }

  /** List all deployments */
  listAll(): Promise<DeploymentRecord[]> {
    return listDeploymentRecords();
  }

  /** Tear down the deployed app and remove the record */
  async destroy(projectId: string): Promise<void> {
    const record = await getDeploymentRecord(projectId);
    if (!record) return;
    const provider = this.getProvider(record.provider);
    await provider.destroy(record.providerAppId);
    await deleteDeploymentRecord(projectId);
  }

  /** Get build logs from the provider */
  async getLogs(projectId: string): Promise<string[]> {
    const record = await getDeploymentRecord(projectId);
    if (!record) return [];
    const provider = this.getProvider(record.provider);
    return provider.getLogs(record.providerAppId, record.deploymentId);
  }
}

// Re-export everything modules need
export { slugifyProjectName, buildBrandedUrl } from './dns-manager';
export type { DeploymentRecord, CustomDomainRecord, DnsRecord } from './types';
export { getDeploymentRecord, listDeploymentRecords } from './deployment-store';
