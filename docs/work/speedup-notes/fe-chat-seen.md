# Chat "Seen" that sometimes never showed

What went wrong: when the buyer opens a chat, the app waits half a second before telling the server "I read it" (so it does not send many calls while someone scrolls). If the buyer leaves the chat inside that half second, the app threw the waiting note away. The server never heard about the read, so the seller never saw "Seen". Under a busy computer the test goes back to the list very fast, so this happened about 1 run in 20. (The earlier guess that the browser cancels the request was wrong: nothing was sent at all. The log of a failing run showed no read call from the buyer.)

Fix: when the chat closes and a seen message is still waiting, the app sends the read note once right then (not when the tab is hidden, not when nothing new was seen, not twice). The unread badge is still set from the server's answer.
Where: packages/web/lib/chat/read-position.ts (dispose). The old unit test "dispose cancels a pending call" said the opposite, so it was replaced by two tests in read-position.test.ts.

Result: 80 of 80 runs passed with 10 busy loops and 3 workers (before: 2 failures in 36 and 2 in 60). Unit tests for chat: 226 pass.
