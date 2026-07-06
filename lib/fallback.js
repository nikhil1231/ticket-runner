'use strict';

function candidateKey(candidate) {
  return `${candidate.provider || ''}\u0000${candidate.model || ''}`;
}

function normalize(candidate) {
  if (!candidate) return null;
  const provider = candidate.provider || candidate.cli;
  if (!provider) return null;
  return { provider, model: candidate.model || '' };
}

// Builds an ordered, de-duplicated provider/model chain. An explicit ticket
// override is tried first; exclusions are useful for avoiding same-on-same
// review without teaching the resolver about any particular service.
function buildCandidateChain(policy = [], { override, exclude = [] } = {}) {
  const excluded = new Set(exclude.map(normalize).filter(Boolean).map(candidateKey));
  const seen = new Set();
  const chain = [];
  for (const raw of [override, ...policy]) {
    const candidate = normalize(raw);
    if (!candidate) continue;
    const key = candidateKey(candidate);
    if (excluded.has(key) || seen.has(key)) continue;
    seen.add(key);
    chain.push(candidate);
  }
  return chain;
}

// Stateless orchestration shared by implementation, planning and review.
// classify returns { action: 'accept'|'stop'|'next', value?, reason? }.
async function runWithFallback({ candidates, invoke, classify, reset, onAdvance }) {
  let last;
  for (let index = 0; index < candidates.length; index++) {
    const candidate = candidates[index];
    const result = await invoke(candidate, index);
    const decision = await classify(result, candidate, index);
    last = { candidate, result, decision };
    if (decision.action === 'accept' || decision.action === 'stop') {
      return { status: decision.action, candidate, result, value: decision.value, decision };
    }
    const next = candidates[index + 1];
    if (onAdvance) await onAdvance({ candidate, next, result, decision, index });
    if (next && reset) await reset({ candidate, next, result, decision, index });
  }
  return { status: 'exhausted', last };
}

module.exports = { candidateKey, buildCandidateChain, runWithFallback };
