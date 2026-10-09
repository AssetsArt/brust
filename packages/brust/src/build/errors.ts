// The one error type of `brust build`: the CLI prints `error <rule> <message>` and exits 1.

export class BuildError extends Error {
  override name = 'BuildError'
  constructor(
    public rule: string,
    message: string,
  ) {
    super(message)
  }
}
