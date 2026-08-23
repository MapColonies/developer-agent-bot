import type { Repo } from '../github/types';
import type { TokenProvider } from '../vcs/types';
import type { PullRequest, PullRequestDraft, PullRequestPort } from './types';

const API = 'https://api.github.com';
const CREATED = 201;

/* eslint-disable @typescript-eslint/naming-convention -- mirrors the GitHub REST wire format */
interface PullRequestResponse {
  number: number;
  html_url: string;
}

/**
 * The request body, in full.
 *
 * `draft: false` is written out rather than left to GitHub's default. It is an acceptance
 * criterion — a draft suppresses some workflows and tends to be scrolled past — and a default
 * is not a decision anyone can read. There is no `assignee`, no `assignees` and no
 * `reviewers` key, because the API cannot leave off a field that was never sent.
 */
interface CreatePullRequest {
  title: string;
  head: string;
  base: string;
  body: string;
  draft: boolean;
  maintainer_can_modify: boolean;
}
/* eslint-enable @typescript-eslint/naming-convention */

/**
 * Opens pull requests over the GitHub REST API.
 *
 * The credential is minted per call from `TokenProvider`, never held on the instance and never
 * read from the environment, so there is no long-lived token for this class to reuse even if a
 * later slice keeps one instance alive for the process's lifetime. The provider itself is
 * MAPCO-11428.
 */
class RestPullRequests implements PullRequestPort {
  public constructor(private readonly tokens: TokenProvider) {}

  public async open(repo: Repo, draft: PullRequestDraft): Promise<PullRequest> {
    const payload: CreatePullRequest = {
      title: draft.title,
      head: draft.head,
      base: draft.base,
      body: draft.body,
      draft: false,
      // Lets a reviewer push a fix onto the agent's branch instead of recreating it by hand.
      // eslint-disable-next-line @typescript-eslint/naming-convention -- GitHub REST wire format
      maintainer_can_modify: true,
    };

    const token = await this.tokens.mint();

    const response = await fetch(`${API}/repos/${repo.fullName}/pulls`, {
      method: 'POST',
      headers: {
        accept: 'application/vnd.github+json',
        authorization: `Bearer ${token}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify(payload),
    });

    // Anything but 201 is a failure, including the 422 GitHub answers with when the branch was
    // never pushed or a pull request for it already exists. None of those are "no pull request
    // needed" — the ticket must not be reported as done because the response was misread.
    if (response.status !== CREATED) {
      throw new Error(`Opening a pull request on ${repo.fullName} failed: ${response.status} ${response.statusText}`);
    }

    const body = (await response.json()) as PullRequestResponse;

    return { number: body.number, url: body.html_url };
  }
}

export { RestPullRequests };
