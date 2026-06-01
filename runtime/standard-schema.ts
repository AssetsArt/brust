/** Minimal Standard Schema v1 surface — https://standardschema.dev */
export interface StandardSchemaV1<Input = unknown, Output = Input> {
  readonly '~standard': {
    readonly version: 1
    readonly vendor: string
    readonly validate: (value: unknown) => StandardResult<Output> | Promise<StandardResult<Output>>
  }
}
type StandardResult<Output> =
  | { readonly value: Output; readonly issues?: undefined }
  | { readonly issues: ReadonlyArray<StandardIssue> }
export interface StandardIssue {
  readonly message: string
  readonly path?: ReadonlyArray<PropertyKey | { key: PropertyKey }>
}
export type InferOutput<S> = S extends StandardSchemaV1<unknown, infer O> ? O : never
export type ValidateOk<T> = { ok: true; value: T }
export type ValidateErr = { ok: false; issues: ReadonlyArray<StandardIssue> }

export async function validate<S extends StandardSchemaV1 | undefined>(
  schema: S, input: unknown,
): Promise<ValidateOk<S extends StandardSchemaV1 ? InferOutput<S> : unknown> | ValidateErr> {
  if (schema === undefined) return { ok: true, value: input as never }
  let result = schema['~standard'].validate(input)
  if (result instanceof Promise) result = await result
  if (result.issues) return { ok: false, issues: result.issues }
  return { ok: true, value: result.value as never }
}
