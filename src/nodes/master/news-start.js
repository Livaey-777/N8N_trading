'use strict';
// Live news run context.
return [{ json: { run: { job: 'NEWS', is_test: false, started_at: new Date().toISOString(), execution_id: $execution.id } } }];
