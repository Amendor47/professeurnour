function validateSheetsPayload(payload){
  const errors = [];
  if (payload?.status !== 'ok') errors.push('status != ok');
  const sheets = payload?.sheets || [];
  if (!Array.isArray(sheets) || sheets.length === 0) errors.push('sheets empty');
  for (const s of sheets){
    if (!s.title || typeof s.title !== 'string') errors.push('missing title');
    const sv = s.short_version, mv = s.medium_version, lv = s.long_version;
    if (!sv || sv.type !== 'bullet_points') errors.push(`${s.title||'?'}: short_version.type must be bullet_points`);
    if (!Array.isArray(sv?.content) || sv.content.length === 0 || sv.content.length > 5) errors.push(`${s.title||'?'}: short_version.content 1..5 bullets`);
    if (!mv || mv.type !== 'paragraphs') errors.push(`${s.title||'?'}: medium_version.type must be paragraphs`);
    if (!Array.isArray(mv?.content) || mv.content.length < 1 || mv.content.length > 2) errors.push(`${s.title||'?'}: medium_version.content 1..2 paragraphs`);
    if (!lv || lv.type !== 'developed' || typeof lv.content !== 'string') errors.push(`${s.title||'?'}: long_version.type must be developed with string content`);
    if (typeof lv?.content === 'string' && lv.content.length < 100) errors.push(`${s.title||'?'}: long_version too short`);
    if (!Array.isArray(s.citations)) errors.push(`${s.title||'?'}: citations missing`);
  }
  return { ok: errors.length === 0, errors };
}

// Expose to window
try{
  if (typeof window !== 'undefined'){
    window.CoachValidators = window.CoachValidators || {};
    window.CoachValidators.validateSheetsPayload = validateSheetsPayload;
  }
}catch(_){ }
