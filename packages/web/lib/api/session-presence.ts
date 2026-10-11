/**
 * Lets the shared API client ask "does the interface believe a member is signed in?" without importing React or the
 * query client. `Providers` registers the answer (the session query's cached user).
 */
let isSignedIn: () => boolean = () => false;

export function setSessionPresence(fn: () => boolean): void {
  isSignedIn = fn;
}

export function believesSignedIn(): boolean {
  return isSignedIn();
}
