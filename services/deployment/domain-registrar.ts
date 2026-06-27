/**
 * Domain Registrar — Route 53 Domains API
 *
 * Provides: domain search, availability check, purchase, transfer check,
 * list of registered domains, and operation status polling.
 *
 * This runs entirely within AWS — users never leave DWOMOH Vibe Code.
 * All purchased domains are associated with Bright's AWS account and
 * automatically wired to the DWOMOH Vibe Code hosting infrastructure.
 */

import {
  Route53DomainsClient,
  CheckDomainAvailabilityCommand,
  CheckDomainTransferabilityCommand,
  RegisterDomainCommand,
  ListDomainsCommand,
  GetDomainDetailCommand,
  GetOperationDetailCommand,
  ListPricesCommand,
  GetDomainSuggestionsCommand,
  type DomainSuggestion,
  Transferable,
  ContactType,
  CountryCode,
} from '@aws-sdk/client-route-53-domains';
import { readFile, writeFile } from 'fs/promises';
import { join } from 'path';

const AWS_ACCESS_KEY_ID    = process.env.AWS_ACCESS_KEY_ID    || '';
const AWS_SECRET_ACCESS_KEY = process.env.AWS_SECRET_ACCESS_KEY || '';

// Route 53 Domains is a global service — always us-east-1
function getClient() {
  return new Route53DomainsClient({
    region: 'us-east-1',
    credentials: { accessKeyId: AWS_ACCESS_KEY_ID, secretAccessKey: AWS_SECRET_ACCESS_KEY },
  });
}

// ─── Types ────────────────────────────────────────────────────────────────────

export interface DomainSearchResult {
  domain: string;
  available: boolean;
  price?: number;
  currency?: string;
  tld: string;
}

export interface DomainSuggestionResult {
  domain: string;
  available: boolean;
}

export interface RegisteredDomain {
  domain: string;
  expiry?: string;
  autoRenew?: boolean;
  transferLock?: boolean;
  status?: string;
}

export interface PurchaseResult {
  operationId: string;
  status: string;
  estimatedCompletion?: string;
}

export interface OperationStatusResult {
  operationId: string;
  status: 'SUBMITTED' | 'IN_PROGRESS' | 'ERROR' | 'SUCCESSFUL' | 'FAILED';
  type?: string;
  message?: string;
  submittedDate?: string;
}

// ─── Default registrant contact (from Bright's account) ──────────────────────

function defaultContact() {
  return {
    ContactType: ContactType.PERSON,
    FirstName: process.env.REGISTRANT_FIRST_NAME || 'Bright',
    LastName: process.env.REGISTRANT_LAST_NAME || 'Dwomoh',
    Email: process.env.REGISTRANT_EMAIL || process.env.DWOMOH_SES_FROM_EMAIL || 'ghanasongs@yahoo.com',
    PhoneNumber: process.env.REGISTRANT_PHONE || '+1.4155551234',
    AddressLine1: process.env.REGISTRANT_ADDRESS || '123 Main Street',
    City: process.env.REGISTRANT_CITY || 'Accra',
    State: process.env.REGISTRANT_STATE || 'GA',
    CountryCode: (process.env.REGISTRANT_COUNTRY || 'GH') as CountryCode,
    ZipCode: process.env.REGISTRANT_ZIP || '00233',
  };
}

// ─── Domain Availability ─────────────────────────────────────────────────────

export async function checkDomainAvailability(domain: string): Promise<DomainSearchResult> {
  const client = getClient();
  const tld = domain.split('.').slice(1).join('.');

  try {
    const [availRes, priceRes] = await Promise.allSettled([
      client.send(new CheckDomainAvailabilityCommand({ DomainName: domain })),
      client.send(new ListPricesCommand({ Tld: tld })),
    ]);

    const available = availRes.status === 'fulfilled'
      && availRes.value.Availability === 'AVAILABLE';

    let price: number | undefined;
    let currency: string | undefined;
    if (priceRes.status === 'fulfilled') {
      const priceEntry = priceRes.value.Prices?.[0];
      price = priceEntry?.RegistrationPrice?.Price;
      currency = priceEntry?.RegistrationPrice?.Currency;
    }

    return { domain, available, price, currency, tld };
  } catch {
    return { domain, available: false, tld };
  }
}

/** Check multiple TLDs for a base name in parallel */
export async function searchDomains(baseName: string): Promise<DomainSearchResult[]> {
  const tlds = ['.com', '.net', '.org', '.io', '.co', '.app', '.dev', '.store', '.online', '.site'];
  const queries = tlds.map(tld => checkDomainAvailability(`${baseName}${tld}`));
  const results = await Promise.all(queries);
  // Sort: available first, then by price ascending
  return results.sort((a, b) => {
    if (a.available !== b.available) return a.available ? -1 : 1;
    return (a.price ?? 9999) - (b.price ?? 9999);
  });
}

/** Get AI-powered domain suggestions for a business name / description */
export async function suggestDomains(keyword: string): Promise<DomainSuggestionResult[]> {
  const client = getClient();
  try {
    const res = await client.send(new GetDomainSuggestionsCommand({
      DomainName: keyword,
      SuggestionCount: 20,
      OnlyAvailable: true,
    }));

    return (res.SuggestionsList ?? []).map((s: DomainSuggestion) => ({
      domain: s.DomainName ?? '',
      available: s.Availability === 'AVAILABLE',
    }));
  } catch {
    return [];
  }
}

// ─── Domain Purchase ──────────────────────────────────────────────────────────

export async function purchaseDomain(domain: string, autoRenew = true): Promise<PurchaseResult> {
  const client = getClient();
  const contact = defaultContact();

  const res = await client.send(new RegisterDomainCommand({
    DomainName: domain,
    DurationInYears: 1,
    AutoRenew: autoRenew,
    AdminContact: contact,
    RegistrantContact: contact,
    TechContact: contact,
    PrivacyProtectAdminContact: true,
    PrivacyProtectRegistrantContact: true,
    PrivacyProtectTechContact: true,
  }));

  return {
    operationId: res.OperationId!,
    status: 'SUBMITTED',
    estimatedCompletion: 'Usually 5–15 minutes for .com domains',
  };
}

// ─── Operation Status ─────────────────────────────────────────────────────────

export async function getOperationStatus(operationId: string): Promise<OperationStatusResult> {
  const client = getClient();
  try {
    const res = await client.send(new GetOperationDetailCommand({ OperationId: operationId }));
    const status = (res.Status ?? 'SUBMITTED') as OperationStatusResult['status'];
    return {
      operationId,
      status,
      type: res.Type,
      message: res.Message,
      submittedDate: res.SubmittedDate?.toISOString(),
    };
  } catch (err) {
    return { operationId, status: 'FAILED', message: String(err) };
  }
}

// ─── Registered Domains ───────────────────────────────────────────────────────

export async function listRegisteredDomains(): Promise<RegisteredDomain[]> {
  const client = getClient();
  try {
    const res = await client.send(new ListDomainsCommand({ MaxItems: 100 }));
    return (res.Domains ?? []).map(d => ({
      domain: d.DomainName!,
      expiry: d.Expiry?.toISOString(),
      autoRenew: d.AutoRenew,
      transferLock: d.TransferLock,
    }));
  } catch {
    return [];
  }
}

export async function getDomainDetail(domain: string): Promise<RegisteredDomain | null> {
  const client = getClient();
  try {
    const res = await client.send(new GetDomainDetailCommand({ DomainName: domain }));
    return {
      domain: res.DomainName!,
      expiry: res.ExpirationDate?.toISOString(),
      autoRenew: res.AutoRenew,
      transferLock: res.DomainName ? true : false,
    };
  } catch {
    return null;
  }
}

// ─── Transferability Check ────────────────────────────────────────────────────

export async function checkTransferability(domain: string): Promise<{ transferable: boolean; reason?: string }> {
  const client = getClient();
  try {
    const res = await client.send(new CheckDomainTransferabilityCommand({ DomainName: domain }));
    const transferable = res.Transferability?.Transferable === Transferable.TRANSFERABLE;
    const reason = transferable ? undefined : `Domain is not transferable (${res.Transferability?.Transferable ?? 'UNKNOWN'})`;
    return { transferable, reason };
  } catch (err) {
    return { transferable: false, reason: String(err) };
  }
}

// ─── Price Lookup ─────────────────────────────────────────────────────────────

export async function getTldPrice(tld: string): Promise<{ registration?: number; renewal?: number; currency?: string }> {
  const client = getClient();
  try {
    const cleanTld = tld.startsWith('.') ? tld.slice(1) : tld;
    const res = await client.send(new ListPricesCommand({ Tld: cleanTld }));
    const entry = res.Prices?.[0];
    return {
      registration: entry?.RegistrationPrice?.Price,
      renewal: entry?.RenewalPrice?.Price,
      currency: entry?.RegistrationPrice?.Currency,
    };
  } catch {
    return {};
  }
}
