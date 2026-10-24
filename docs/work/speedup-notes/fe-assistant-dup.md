# Assistant answer shown twice after a reload

What happened: after a reload, sometimes the assistant's answer showed up two times.

Why: the page remembers the running answer by a number the server calls the "turn number". When the page reloads right after the answer finished, it may still hold that number and read the answer again from the live stream, while also loading the saved chat. To avoid showing both, the page looked for a saved message whose own number equals the turn number. But a saved message has its own different number; only its "turn" field equals the turn number. So the look-up never matched and both copies were shown (only when the reload came before the page had tidied up its note, hence 1 in ~5).

Fix: match on the saved message's turn field (still also on its own number). Same mistake fixed in the "read the finished answer from the saved chat" fallback (lib/assistant/drive-reply.ts). Code: hooks/use-assistant-chat.ts.
