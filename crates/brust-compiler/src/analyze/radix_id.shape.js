const $useReactId = React[" useId ".trim().toString()] || (() => {
  return;
});
let $count = 0;
function useId($deterministicId) {
  const [$id, $setId] = React.useState($useReactId());
  useLayoutEffect(() => {
    if (!$deterministicId)
      $setId(($reactId) => $reactId ?? String($count++));
  }, [$deterministicId]);
  return $deterministicId || ($id ? `radix-${$id}` : "");
}
