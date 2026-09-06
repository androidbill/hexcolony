// Open Trivia Database client (https://opentdb.com). No API key needed, CORS-open.

const API = 'https://opentdb.com/api.php';
const CATEGORY_API = 'https://opentdb.com/api_category.php';

const RESPONSE_MESSAGES = {
  1: 'Not enough questions for that category/difficulty — try a broader pick.',
  2: 'That request was invalid.',
  3: 'Question session expired.',
  4: 'Ran out of fresh questions for that filter — some may repeat.',
  5: 'Too many requests — wait a few seconds and try again.',
};

// The API hands back HTML-entity-encoded text ("&quot;", "&#039;", ...). Decoding through
// a throwaway element is the one reliable way to cover the whole entity set without
// hand-rolling a lookup table.
const decoder = document.createElement('textarea');
function decodeEntities(s) {
  decoder.innerHTML = s;
  return decoder.value;
}

function shuffle(arr) {
  const a = arr.slice();
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

/** Category list for the host's picker: [{ id, name }, ...]. */
export async function fetchCategories() {
  const res = await fetch(CATEGORY_API);
  if (!res.ok) throw new Error(`Category list failed (HTTP ${res.status})`);
  const data = await res.json();
  return data.trivia_categories;
}

/**
 * Fetch `amount` questions and return them pre-shuffled and de-HTML'd, ready to store
 * verbatim in the room so every player sees the same option order.
 *
 * @param {{amount:number, category?:string, difficulty?:string}} opts
 * @returns {Promise<Array<{question:string, category:string, difficulty:string,
 *   options:string[], correctIndex:number}>>}
 */
export async function fetchQuestions({ amount, category, difficulty }) {
  const params = new URLSearchParams({ amount: String(amount), type: 'multiple' });
  if (category) params.set('category', category);
  if (difficulty) params.set('difficulty', difficulty);

  const res = await fetch(`${API}?${params}`);
  if (!res.ok) throw new Error(`Trivia API failed (HTTP ${res.status})`);
  const data = await res.json();
  if (data.response_code !== 0) {
    throw new Error(RESPONSE_MESSAGES[data.response_code] || 'Trivia API returned no questions.');
  }

  return data.results.map((q) => {
    const options = shuffle([...q.incorrect_answers, q.correct_answer]).map(decodeEntities);
    return {
      question: decodeEntities(q.question),
      category: decodeEntities(q.category),
      difficulty: q.difficulty,
      options,
      correctIndex: options.indexOf(decodeEntities(q.correct_answer)),
    };
  });
}
