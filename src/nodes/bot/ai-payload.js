'use strict';
// Hands the user-requested AI explanation (🔮 BIGGEST SCENARIOS) to the AI Analyst sub-workflow.
return [{ json: { payload: $('Build Replies').first().json.ai_payload } }];
