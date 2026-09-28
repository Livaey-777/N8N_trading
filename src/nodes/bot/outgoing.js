'use strict';
// Single hand-off to the Telegram sender: merged replies when an AI explanation was requested,
// otherwise the replies built from stored state. Internal fields are stripped.
const built = $('Build Replies').first().json;
const merged = built.has_ai ? $input.first().json : null;
const messages = ((merged && merged.payload && merged.payload.messages) || built.payload.messages || [])
  .map(({ ai_ref: _ref, biggest: _biggest, prefix: _prefix, ...m }) => m);
return [{ json: { payload: { messages } } }];
