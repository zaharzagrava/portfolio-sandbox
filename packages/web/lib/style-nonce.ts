/**
 * Some libraries (sonner) inject a `<style>` element at import time and cannot be given the CSP nonce. This gives every
 * `<style>` appended to `<head>` the page's nonce (readable from the `nonce` property of any nonced script, which the
 * browser keeps even though it blanks the attribute). Import it before such a library. No effect on the server, in
 * development without a nonce, or for styles that already carry one.
 */
if (typeof document !== 'undefined') {
  const nonce = document.querySelector<HTMLScriptElement>('script[nonce]')?.nonce;
  if (nonce) {
    const append = document.head.appendChild.bind(document.head);
    document.head.appendChild = ((node: Node) => {
      if (node instanceof HTMLStyleElement && !node.nonce) node.nonce = nonce;
      return append(node);
    }) as typeof document.head.appendChild;
  }
}

export {};
