export interface Repo {
  /** GitHub's own spelling, which is the only one anything downstream should use. */
  readonly name: string;
  readonly fullName: string;
  readonly defaultBranch: string;
  readonly cloneUrl: string;
}

export interface GitHubPort {
  /** Resolves a repo name in the org, or null if no such repo exists. */
  findRepo: (name: string) => Promise<Repo | null>;
}
