export function restLoader({ params }: { params: { rest: string } }) {
  return { rest: params.rest }
}
