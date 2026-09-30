// TỰ SINH từ vendor/rewrite/execution/rewrite_engine.py — seed mặc định (fallback).
// Sửa prompt: dùng trang Cài đặt → Prompt rewrite (lưu vào Atlas), KHÔNG sửa file này.
export const DEFAULT_MODES = [
  {
    "key": "normal",
    "label": "Normal",
    "template": "You are an expert content rewriter. Your task is to completely rewrite the following subtitle rows from {source_lang} to {target_lang} so the output is 100% original and undetectable by any plagiarism or content-matching system (YouTube Content ID, Copyscape, etc.).\n\nPRIMARY GOAL — COPYRIGHT AVOIDANCE:\n- Every single line must be rewritten so thoroughly that it cannot be traced back to the original source.\n- Change sentence structures, word choices, phrasing patterns, and expressions entirely.\n- The rewritten text must convey the same meaning/information but read as if written from scratch by a completely different person.\n- Aim for less than 20% word overlap with the original text on any given line.\n- If source and target languages are the same: this is a PURE REWRITE for originality. Restructure aggressively — swap clause order, use synonyms, change passive/active voice, rephrase idioms, etc.\n- If source and target languages differ: translate AND rewrite simultaneously. Do not translate literally first then tweak — produce a fresh, natural version directly in {target_lang}.\n\nADAPT TO THE CONTENT:\n- Topic: {topic}\n- Context: {context}\n- Whatever the subject matter (drama, documentary, tutorial, news, comedy, sports, cooking, gaming, podcast, lecture, etc.), use vocabulary and tone natural for that domain in {target_lang}.\n- Preserve the intent, emotion, and information of each line — but express it in your own original way.\n- Maintain character voices if dialogue is present; keep technical accuracy if the content is specialized.\n\nStrict Requirements:\n1. Preserve Format: Keep the original STT (Index) and Timestamps exactly as provided.\n2. Deep Rewrite: Every line must be substantially different from the original. Surface-level synonym swaps are NOT enough — restructure the sentence.\n3. Flow & Coherence: Ensure natural, seamless flow between consecutive lines appropriate to the content style.\n4. Consistency: Maintain consistent terminology, proper nouns, character names, and tone throughout the entire batch.\n5. Output Only: Return ONLY the processed rows. Do not include any explanations or conversational text.\n\nCRITICAL — ONE-TO-ONE MAPPING (ABSOLUTE RULE):\n- The input contains EXACTLY {row_count} rows. Your output MUST contain EXACTLY {row_count} rows — no more, no fewer.\n- Each input STT must appear EXACTLY ONCE in the output, with the same STT number and the same Timestamp.\n- DO NOT merge two input rows into one output row.\n- DO NOT split one input row into two output rows.\n- DO NOT skip, drop, or omit any row — even if a line seems short, repetitive, or hard to rephrase. Always return a rephrased version.\n- DO NOT add any extra rows that weren't in the input.\n- DO NOT fill any row with placeholder text like \"empty\", \"blank\", \"no content\", or any equivalent in any language. Every row MUST contain a genuine translation/rewrite of the original text.\n- Before returning, verify: the list of STTs in your output must match these input STTs exactly: {stt_list}\n\nFormat: STT | Timestamp | New_Text\n\nAfter the last row, append exactly this checksum line:\nTOTAL_ROWS: {row_count}\n\nSubtitle Rows to Process:\n{subtitles_data}",
    "enabled": true,
    "order": 0
  },
  {
    "key": "manhwa",
    "label": "Manhwa",
    "template": "You are an expert manhwa/webtoon content rewriter. Your task is to completely rewrite subtitle rows from a manhwa video from {source_lang} to {target_lang} so the output is 100% original and undetectable by any plagiarism or content-matching system (YouTube Content ID, Copyscape, etc.).\n\nPRIMARY GOAL — COPYRIGHT AVOIDANCE:\n- Every single line must be rewritten so thoroughly that it cannot be traced back to the original source.\n- Change sentence structures, word choices, phrasing patterns, and expressions entirely.\n- The rewritten text must convey the same story/meaning but read as if written from scratch by a completely different person.\n- Aim for less than 20% word overlap with the original text on any given line.\n- If source and target languages are the same: restructure aggressively — swap clause order, use synonyms, change passive/active voice, rephrase idioms, reword narration completely.\n- If source and target languages differ: translate AND rewrite simultaneously. Produce a fresh, natural version directly in {target_lang} — do NOT translate literally then tweak.\n\nDomain Knowledge — Manhwa/Webtoon Video Subtitles:\n- These subtitles come from narrated manhwa videos (YouTube, etc.) — a narrator reads the story aloud, with character dialogue voiced in different tones.\n- Lines alternate between narrator exposition and character dialogue. Preserve this distinction clearly.\n- Character voice consistency is critical: each character must sound distinctly different based on their personality and role. Maintain each character's speech register (formal vs informal, polite vs crude) consistently throughout.\n- Genre-specific terminology: manhwa spans many genres (Fantasy/Murim, Romance, School Life, Horror, Sci-Fi, BL/GL, Slice of Life, Regression/Isekai, etc.). Whatever specialized terms appear in the input, maintain consistent translations for the same term throughout the ENTIRE batch.\n- Character names and proper nouns: keep them consistent. The same character must always have the same name spelling.\n- Titles, ranks, honorifics, and relationship terms: translate consistently or keep as-is — pick one approach and stick with it.\n- Onomatopoeia and SFX: rewrite into natural equivalents in {target_lang} that convey the same impact. Do NOT delete them.\n- Slang, profanity, and informal speech: adapt to equivalent natural expressions in {target_lang}. Crude characters must stay crude. Formal characters must stay formal.\n- Emotional tone: preserve the intensity — tense scenes stay tense, comedic moments stay funny, romantic lines stay heartfelt.\n\nTopic: {topic}\nContext: {context}\n\nStrict Requirements:\n1. Preserve Format: Keep the original STT (Index) and Timestamps exactly as provided.\n2. Deep Rewrite: Every line must be substantially different from the original. Surface-level synonym swaps are NOT enough — restructure the sentence. Aim for at least 80% different wording.\n3. Flow & Coherence: Ensure natural, dramatic flow between consecutive lines. Scene transitions must be smooth.\n4. Consistency: Maintain consistent character voices, terminology, names, and tone throughout the batch.\n5. Output Only: Return ONLY the processed rows. Do not include any explanations or conversational text.\n\nCRITICAL — ONE-TO-ONE MAPPING (ABSOLUTE RULE):\n- The input contains EXACTLY {row_count} rows. Your output MUST contain EXACTLY {row_count} rows — no more, no fewer.\n- Each input STT must appear EXACTLY ONCE in the output, with the same STT number and the same Timestamp.\n- DO NOT merge two input rows into one output row.\n- DO NOT split one input row into two output rows.\n- DO NOT skip, drop, or omit any row — even if a line seems short, repetitive, or hard to rephrase. Always return a rephrased version.\n- DO NOT add any extra rows that weren't in the input.\n- DO NOT fill any row with placeholder text like \"empty\", \"blank\", \"no content\", or any equivalent in any language. Every row MUST contain a genuine translation/rewrite of the original text.\n- Before returning, verify: the list of STTs in your output must match these input STTs exactly: {stt_list}\n\nFormat: STT | Timestamp | New_Text\n\nAfter the last row, append exactly this checksum line:\nTOTAL_ROWS: {row_count}\n\nSubtitle Rows to Process:\n{subtitles_data}",
    "enabled": true,
    "order": 1
  }
];

export const DEFAULT_LANGS = [
  {
    "key": "vi",
    "label": "Tiếng Việt",
    "value": "Vietnamese",
    "enabled": true,
    "order": 0
  },
  {
    "key": "en",
    "label": "Tiếng Anh (Mỹ)",
    "value": "English",
    "enabled": true,
    "order": 1
  },
  {
    "key": "ko",
    "label": "Tiếng Hàn",
    "value": "Korean",
    "enabled": true,
    "order": 2
  },
  {
    "key": "th",
    "label": "Tiếng Thái",
    "value": "Thai",
    "enabled": true,
    "order": 3
  },
  {
    "key": "ar",
    "label": "Tiếng Ả-rập",
    "value": "Arabic",
    "enabled": true,
    "order": 4
  }
];

export const ALLOWED_PLACEHOLDERS = ["source_lang", "target_lang", "topic", "context", "row_count", "stt_list", "subtitles_data"];
