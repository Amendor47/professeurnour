export function validateMcqPayload(payload){
  const errors = [];
  if (payload?.status !== 'ok') errors.push('status != ok');
  const items = payload?.items || [];
  if (!Array.isArray(items) || items.length === 0) errors.push('items empty');
  for (const it of items){
    // Accept either single answer_index or multi answer_indices
    const hasSingle = Number.isInteger(it.answer_index);
    const hasMulti = Array.isArray(it.answer_indices);
    if (!hasSingle && !hasMulti) errors.push(`${it.id}: missing answer_index or answer_indices`);
    if (!Array.isArray(it.options) || it.options.length !== 4) errors.push(`${it.id}: options must be 4`);
    if (new Set(it.options).size !== it.options.length) errors.push(`${it.id}: duplicate options`);
    if (hasSingle){
      if (it.answer_index < 0 || it.answer_index > 3) errors.push(`${it.id}: answer_index out of range`);
      if (/toutes/i.test(it.options[it.answer_index] || '')) errors.push(`${it.id}: invalid "Toutes les réponses"`);
    }
    if (hasMulti){
      if (it.answer_indices.length < 1 || it.answer_indices.length > 4) errors.push(`${it.id}: answer_indices size invalid`);
      const uniq = new Set(it.answer_indices);
      if (uniq.size !== it.answer_indices.length) errors.push(`${it.id}: duplicate indices in answer_indices`);
      for (const a of it.answer_indices){
        if (!Number.isInteger(a) || a < 0 || a > 3) errors.push(`${it.id}: answer_indices out of range`);
      }
    }
  if (typeof it.question !== 'string' || !it.question.trim()) errors.push(`${it.id}: empty question`);
  // Basic leakage: question shouldn't contain option text or the exact correct answer
  const q = (it.question || '').toLowerCase();
    const candidates = hasMulti ? (it.answer_indices||[]).map(i=> String(it.options?.[i]||'').toLowerCase()) : [String(it.options?.[it.answer_index]||'').toLowerCase()];
    for (const correct of candidates){
      if (correct && q.includes(correct.substring(0, Math.min(8, correct.length)))) { errors.push(`${it.id}: answer leakage in question`); break; }
    }
  // Enums for difficulty and bloom
  if (!['easy','medium','hard'].includes(it.difficulty)) errors.push(`${it.id}: invalid difficulty`);
  if (!['rappel','compréhension','application','analyse'].includes(it.bloom)) errors.push(`${it.id}: invalid bloom`);
  }
  return { ok: errors.length === 0, errors };
}

// Expose to window for non-module consumers
try{
  if (typeof window !== 'undefined'){
    window.CoachValidators = window.CoachValidators || {};
    window.CoachValidators.validateMcqPayload = validateMcqPayload;
  }
}catch(_){ }
