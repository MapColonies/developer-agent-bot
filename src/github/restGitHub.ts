import type { GitHubPort, Repo } from './types';

const ORG = 'MapColonies';
const API = 'https://api.github.com';
const NOT_FOUND = 404;

/* eslint-disable @typescript-eslint/naming-convention -- mirrors the GitHub REST wire format */
interface RepoResponse {
  name: string;
  full_name: string;
  default_branch: string;
  clone_url: string;
}
/* eslint-enable @typescript-eslint/naming-convention */

/**
 * Read-only repo lookup.
 *
 * Auth is a bearer token supplied by the caller so this stays indifferent to where it came
 * from: a PAT locally, a short-lived App installation token in the cluster once
 * MAPCO-11428 lands. Unauthenticated works too, at a much lower rate limit.
 */
export class RestGitHub implements GitHubPort {
  public constructor(
    private readonly token?: string,
    private readonly org: string = ORG
  ) {}

  public async findRepo(name: string): Promise<Repo | null> {
    const headers: Record<string, string> = { accept: 'application/vnd.github+json' };
    if (this.token !== undefined && this.token !== '') {
      headers.authorization = `Bearer ${this.token}`;
    }

    const response = await fetch(`${API}/repos/${this.org}/${encodeURIComponent(name)}`, { headers });

    if (response.status === NOT_FOUND) {
      return null;
    }

    if (!response.ok) {
      throw new Error(`GitHub lookup for ${this.org}/${name} failed: ${response.status} ${response.statusText}`);
    }

    // GitHub matches names case-insensitively and answers with the canonical spelling.
    // Everything downstream uses that, never the spelling a human typed in a ticket title.
    const body = (await response.json()) as RepoResponse;

    return {
      name: body.name,
      fullName: body.full_name,
      defaultBranch: body.default_branch,
      cloneUrl: body.clone_url,
    };
  }
}
