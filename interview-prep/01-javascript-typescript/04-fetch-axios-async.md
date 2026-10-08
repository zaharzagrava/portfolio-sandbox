# Fetch, Axios, and Async Error Handling

When consuming APIs in Node.js or the browser, the two most common libraries are the native `fetch` (now built into Node.js 18+) and `axios`.

---

## 1. Fetch vs Axios

### `fetch`
The native `fetch` API only rejects its Promise if there is a **network error** (e.g., DNS lookup failure, connection refused, or the user is offline). 
It **does not reject** on HTTP error statuses (like `404 Not Found` or `500 Internal Server Error`).

```javascript
// Native fetch requires manual ok checking
const response = await fetch('https://api.example.com/weather?q=Seoul');

if (!response.ok) { // response.ok is true for 200-299 status codes
  const errorData = await response.json();
  throw new Error(errorData.message || 'API request failed');
}

const data = await response.json();
```

### `axios`
`axios` automatically rejects its Promise for any HTTP status code outside the `2xx` range. This makes it more ergonomic for error handling, as `404` and `500` errors will immediately jump to your `catch` block.

```javascript
try {
  // Axios automatically throws on 404
  const response = await axios.get('https://api.example.com/weather?q=Seoul');
  console.log(response.data); 
} catch (error) {
  // Axios attaches the response object to the error
  const message = error.response?.data?.message || 'city not found';
  throw new Error(message);
}
```

---

## 2. Async/Await Error Handling Patterns

### The standard `try/catch`
When you mark a function as `async`, any error thrown inside it (or any awaited Promise that rejects) automatically results in the async function returning a rejected Promise.

```javascript
async function getWeather(city) {
  if (!city) {
    // This is identical to: return Promise.reject(new Error('empty city'))
    throw new Error('empty city');
  }

  try {
    const res = await axios.get(`.../?q=${city}`);
    return res.data; 
  } catch (err) {
    // We catch the axios error and throw a custom one
    throw new Error(err.response?.data?.message || 'Server error');
  }
}
```

### The "Go-style" tuple wrapper
A common pattern in modern JS/TS codebases to avoid deep `try/catch` nesting is to use a wrapper utility that returns a tuple of `[error, data]`, similar to Golang.

```javascript
async function to(promise) {
  return promise
    .then(data => [null, data])
    .catch(err => [err, null]);
}

async function getWeather(city) {
  const [err, res] = await to(axios.get(`.../?q=${city}`));
  
  if (err) {
    throw new Error(err.response?.data?.message);
  }
  
  return res.data;
}
```

---

## Interview Q&A

**Q: Why does `fetch('https://google.com/404')` resolve instead of reject?**
A: `fetch` only rejects on network failures (like being offline). It considers receiving an HTTP response—even an error like 404 or 500—to be a successful network transaction. You must manually check `response.ok` or `response.status` to handle HTTP errors.

**Q: In an `async` function, what is the difference between `throw new Error()` and `return Promise.reject(new Error())`?**
A: Functionally, there is no difference from the caller's perspective. The `async` keyword ensures that any thrown exception is implicitly caught and converted into a rejected Promise. However, `throw new Error()` is generally preferred as it is more idiomatic synchronous-looking syntax.
