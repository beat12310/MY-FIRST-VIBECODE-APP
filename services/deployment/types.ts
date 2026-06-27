// ─── Deployment System Types ──────────────────────────────────────────────────

export type DeployProviderName = 'amplify' | 'vercel' | 'netlify' | 'railway' | 'cloudflare';

export type DeploymentStatus =
  | 'pending'
  | 'packaging'
  | 'uploading'
  | 'building'
  | 'configuring_domain'
  | 'verifying'
  | 'live'
  | 'failed';

// ─── Live verification ──────────────────────────────────────────────────────

export type VerificationCheckName =
  | 'amplify_domain'
  | 'cname_route53'
  | 'dns_resolution'
  | 'ssl_certificate'
  | 'http_response'
  | 'page_crawl'
  | 'navigation'
  | 'api_health';

export type VerificationCheckStatus = 'pass' | 'fail' | 'warning' | 'skipped';

export interface VerificationCheck {
  name: VerificationCheckName;
  label: string;
  status: VerificationCheckStatus;
  detail: string;
  durationMs?: number;
  timestamp: string;
}

export interface VerificationResult {
  passed: boolean;
  url: string;
  httpStatus?: number;
  pageTitle?: string;
  checks: VerificationCheck[];
  attempts: number;
  totalDurationMs: number;
  completedAt: string;
  repairLog?: string[];
}

export type DomainStatus =
  | 'pending_verification'
  | 'verifying'
  | 'active'
  | 'failed';

export interface DeployConfig {
  projectId: string;
  projectName: string;
  /** URL-safe slug derived from projectName — becomes {slug}.dwomohvibe.app */
  slug: string;
  projectPath: string;
  /** Environment variables to inject into the deployment */
  envVars?: Record<string, string>;
  /** Override default provider */
  provider?: DeployProviderName;
}

export interface DeployResult {
  /** Provider-internal deployment/job ID */
  deploymentId: string;
  /** Provider-internal app ID (e.g., Amplify appId) */
  providerAppId: string;
  /** Raw provider URL (e.g., *.amplifyapp.com) — never shown to users */
  providerUrl: string;
  /** Branded URL shown to users: {slug}.dwomohvibe.app */
  brandedUrl: string;
  status: DeploymentStatus;
  provider: DeployProviderName;
  startedAt: string;
}

export interface DeploymentRecord {
  deploymentId: string;
  projectId: string;
  projectName: string;
  slug: string;
  provider: DeployProviderName;
  providerAppId: string;
  providerUrl: string;
  brandedUrl: string;
  status: DeploymentStatus;
  /** Human-readable status detail shown in the sidebar */
  statusDetail?: string;
  startedAt: string;
  completedAt?: string;
  errorMessage?: string;
  /** Full result of the live verification pass */
  verificationResult?: VerificationResult;
  /** Custom domains attached to this deployment */
  customDomains: CustomDomainRecord[];
}

export interface CustomDomainRecord {
  domain: string;
  status: DomainStatus;
  /** DNS records the user must add to their registrar */
  dnsRecords?: DnsRecord[];
  addedAt: string;
  verifiedAt?: string;
}

export interface DnsRecord {
  type: 'CNAME' | 'A' | 'AAAA' | 'TXT';
  name: string;
  value: string;
  ttl?: number;
}

export interface DeployStatusResult {
  deploymentId: string;
  status: DeploymentStatus;
  brandedUrl: string;
  providerUrl: string;
  logs?: string[];
  completedAt?: string;
  errorMessage?: string;
}

// ─── Provider interface — implement this to add Vercel, Netlify, Railway, etc. ─

export interface DeploymentProvider {
  readonly name: DeployProviderName;
  readonly displayName: string;

  /** Deploy a project — returns immediately with a deploymentId, then polls for status */
  deploy(config: DeployConfig): Promise<DeployResult>;

  /** Poll provider for current job status */
  getStatus(providerAppId: string, deploymentId: string): Promise<DeployStatusResult>;

  /** Get raw build logs from the provider */
  getLogs(providerAppId: string, deploymentId: string): Promise<string[]>;

  /** Attach a custom domain to a deployed app */
  attachDomain(providerAppId: string, domain: string): Promise<CustomDomainRecord>;

  /** Remove a custom domain from a deployed app */
  detachDomain(providerAppId: string, domain: string): Promise<void>;

  /** Delete the deployed app entirely */
  destroy(providerAppId: string): Promise<void>;
}
