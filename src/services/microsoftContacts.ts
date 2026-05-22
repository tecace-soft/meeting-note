export type MicrosoftContact = {
  id: string;
  displayName: string;
  email: string;
  userPrincipalName: string;
};

type GraphDirectoryUser = {
  id?: string;
  displayName?: string;
  mail?: string | null;
  userPrincipalName?: string | null;
};

const COMPANY_DOMAIN = 'tecace.com';

function decodeJwtPayload(token: string): Record<string, unknown> | null {
  const payload = token.split('.')[1];
  if (!payload) return null;
  try {
    const normalized = payload.replace(/-/g, '+').replace(/_/g, '/');
    const padded = normalized.padEnd(Math.ceil(normalized.length / 4) * 4, '=');
    return JSON.parse(atob(padded)) as Record<string, unknown>;
  } catch {
    return null;
  }
}

function belongsToCompanyDomain(user: GraphDirectoryUser): boolean {
  const mail = user.mail?.toLowerCase() ?? '';
  const upn = user.userPrincipalName?.toLowerCase() ?? '';
  return mail.endsWith(`@${COMPANY_DOMAIN}`) || upn.endsWith(`@${COMPANY_DOMAIN}`);
}

function toMicrosoftContact(user: GraphDirectoryUser): MicrosoftContact | null {
  if (!user.id || !user.displayName?.trim()) return null;
  const email = user.mail?.trim() || user.userPrincipalName?.trim() || '';
  if (!email) return null;

  return {
    id: user.id,
    displayName: user.displayName.trim(),
    email,
    userPrincipalName: user.userPrincipalName?.trim() || email,
  };
}

export async function fetchTecAceContacts(accessToken: string): Promise<MicrosoftContact[]> {
  const tokenPayload = decodeJwtPayload(accessToken);
  const scopes = typeof tokenPayload?.scp === 'string' ? tokenPayload.scp : '';

  if (!scopes.split(' ').includes('User.ReadBasic.All')) {
    throw new Error(
      `Microsoft access token is missing User.ReadBasic.All. Current token scopes: ${scopes || 'none'}`
    );
  }

  let requestUrl = 'https://graph.microsoft.com/v1.0/users?$select=id,displayName,mail,userPrincipalName&$top=999';
  const users: GraphDirectoryUser[] = [];

  while (requestUrl) {
    const response = await fetch(requestUrl, {
      headers: {
        Authorization: `Bearer ${accessToken}`,
        Accept: 'application/json',
      },
    });
    const body = (await response.json().catch(() => null)) as
      | {
          value?: GraphDirectoryUser[];
          '@odata.nextLink'?: string;
          error?: { code?: string; message?: string };
        }
      | null;

    if (!response.ok) {
      const graphCode = body?.error?.code ? `${body.error.code}: ` : '';
      const graphMessage = body?.error?.message || response.statusText || 'Unknown Graph error';
      throw new Error(`Microsoft Graph /users failed (${response.status}). ${graphCode}${graphMessage}`);
    }

    users.push(...(Array.isArray(body?.value) ? body.value : []));
    requestUrl = typeof body?.['@odata.nextLink'] === 'string' ? body['@odata.nextLink'] : '';
  }

  return users
    .filter(belongsToCompanyDomain)
    .map(toMicrosoftContact)
    .filter((contact): contact is MicrosoftContact => Boolean(contact))
    .sort((a, b) => a.displayName.localeCompare(b.displayName));
}
