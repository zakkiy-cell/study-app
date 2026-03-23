'use strict';

import { initializeApp }                                              from 'https://www.gstatic.com/firebasejs/10.14.1/firebase-app.js';
import { getAuth, GoogleAuthProvider, signInWithPopup, signOut,
         onAuthStateChanged }                                         from 'https://www.gstatic.com/firebasejs/10.14.1/firebase-auth.js';
import { getFirestore, doc, getDoc, setDoc, deleteDoc,
         collection, getDocs }                                        from 'https://www.gstatic.com/firebasejs/10.14.1/firebase-firestore.js';
import firebaseConfig from './firebase-config.js';

// Initialize Firebase
const fbApp = initializeApp(firebaseConfig);
const auth  = getAuth(fbApp);
const db    = getFirestore(fbApp);

// ===== Firestore Manager =====
class FirestoreManager {

  // ── Exam Library ──────────────────────────────────
  async getRegisteredExams() {
    const snap = await getDocs(collection(db, 'exams'));
    return snap.docs.map(d => d.data());
  }

  async getExamById(examId) {
    const snap = await getDoc(doc(db, 'exams', examId));
    return snap.exists() ? snap.data() : null;
  }

  async registerExam(data) {
    await setDoc(doc(db, 'exams', data.meta.id), data);
  }

  async deleteExam(examId) {
    await deleteDoc(doc(db, 'exams', examId));
  }

  // ── Per-User Stats ────────────────────────────────
  async getExamStats(uid, examId) {
    const snap = await getDoc(doc(db, 'users', uid, 'stats', examId));
    return snap.exists() ? snap.data() : { questions: {}, sessions: [] };
  }

  async recordSessionResults(uid, examId, answers, session) {
    const ref  = doc(db, 'users', uid, 'stats', examId);
    const snap = await getDoc(ref);
    const data = snap.exists() ? snap.data() : { questions: {}, sessions: [] };

    // Update per-question stats
    for (const a of answers) {
      const key = String(a.questionId);
      if (!data.questions[key]) data.questions[key] = { correct: 0, total: 0 };
      data.questions[key].total++;
      if (a.isCorrect) data.questions[key].correct++;
    }

    // Append session summary
    data.sessions.push({
      date: new Date().toISOString(),
      mode: session.mode,
      score: session.score,
      correct: session.correct,
      total: session.total,
      durationSec: session.durationSec,
    });
    if (data.sessions.length > 50) data.sessions = data.sessions.slice(-50);

    await setDoc(ref, data);
  }

  async getWeakQuestionIds(uid, examId, threshold = 0.7) {
    const stats = await this.getExamStats(uid, examId);
    return Object.entries(stats.questions)
      .filter(([, s]) => s.total > 0 && (s.correct / s.total) < threshold)
      .map(([id]) => id);
  }

  async clearExamStats(uid, examId) {
    await deleteDoc(doc(db, 'users', uid, 'stats', examId));
  }
}

// ===== Quiz Session =====
class QuizSession {
  constructor({ questions, mode, examId, timeLimit = null }) {
    this.questions    = questions;
    this.mode         = mode;
    this.examId       = examId;
    this.timeLimitSec = timeLimit ? timeLimit * 60 : null;
    this.currentIndex = 0;
    this.answers      = [];
    this.startTime    = Date.now();
    this.answered     = false;
  }

  get current()      { return this.questions[this.currentIndex]; }
  get total()        { return this.questions.length; }
  get isDone()       { return this.currentIndex >= this.total; }
  get elapsedSec()   { return Math.floor((Date.now() - this.startTime) / 1000); }
  get remainingSec() {
    if (!this.timeLimitSec) return null;
    return Math.max(0, this.timeLimitSec - this.elapsedSec);
  }

  submitAnswer(choiceIndex) {
    const q = this.current;
    const isCorrect = choiceIndex === q.answer;
    this.answers.push({
      questionId: q.id,
      question: q.question,
      choices: q.choices,
      correctAnswer: q.answer,
      selectedAnswer: choiceIndex,
      isCorrect,
      category: q.category,
      explanation: q.explanation,
    });
    this.answered = true;
    return isCorrect;
  }

  next() { this.currentIndex++; this.answered = false; }

  getResults() {
    const correct = this.answers.filter(a => a.isCorrect).length;
    const total   = this.answers.length;
    const score   = total > 0 ? Math.round((correct / total) * 100) : 0;
    const cats    = {};
    for (const a of this.answers) {
      if (!cats[a.category]) cats[a.category] = { correct: 0, total: 0 };
      cats[a.category].total++;
      if (a.isCorrect) cats[a.category].correct++;
    }
    const categories = Object.entries(cats).map(([name, s]) => ({
      name, correct: s.correct, total: s.total,
      pct: Math.round((s.correct / s.total) * 100),
    })).sort((a, b) => a.pct - b.pct);
    return {
      correct, total, score,
      durationSec: this.elapsedSec,
      mode: this.mode,
      categories,
      answers: this.answers,
      wrongAnswers: this.answers.filter(a => !a.isCorrect),
    };
  }
}

// ===== Main App =====
class App {
  constructor() {
    this.storage      = new FirestoreManager();
    this.currentUser  = null;   // Firebase Auth User
    this.exam         = null;
    this._cachedExams = null;
    this.session      = null;
    this.timerInterval = null;
    this.lastResults  = null;
    this._init();
  }

  _init() {
    this._bindEvents();

    // loading-overlay is visible by default (HTML); hide after auth resolves
    onAuthStateChanged(auth, async (user) => {
      if (user) {
        this.currentUser = user;
        this._updateUserIndicator();
        try {
          await this._renderLibrary();
        } catch (e) {
          console.error(e);
          this._toast('データの読み込みに失敗しました');
        }
        this.showScreen('home');
      } else {
        this.currentUser = null;
        this._updateUserIndicator();
        this.showScreen('login');
      }
      document.getElementById('loading-overlay').classList.add('hidden');
    });
  }

  // ── Screen Management ──────────────────────────────
  showScreen(name) {
    document.querySelectorAll('.screen').forEach(s => s.classList.remove('active'));
    const target = document.getElementById(`screen-${name}`);
    if (target) target.classList.add('active');
    this.currentScreen = name;
    window.scrollTo(0, 0);
  }

  // ── User Indicator in Header ───────────────────────
  _updateUserIndicator() {
    const indicator = document.getElementById('user-indicator');
    if (!this.currentUser) {
      indicator.style.display = 'none';
      return;
    }
    indicator.style.display = '';
    const name = this.currentUser.displayName || this.currentUser.email || 'User';
    document.getElementById('current-user-name').textContent = name.split(' ')[0];

    const avatar = document.getElementById('user-indicator-avatar');
    if (this.currentUser.photoURL) {
      avatar.innerHTML = `<img src="${this.currentUser.photoURL}" alt="" style="width:100%;height:100%;border-radius:50%;object-fit:cover;display:block;">`;
      avatar.style.background = 'none';
    } else {
      avatar.textContent = name.charAt(0).toUpperCase();
      avatar.style.background = this._userColor(this.currentUser.uid);
    }
  }

  _userColor(uid) {
    const colors = ['#4F46E5','#7C3AED','#DB2777','#DC2626','#D97706','#059669','#0891B2','#1D4ED8'];
    let hash = 0;
    for (const c of uid) hash = (hash * 31 + c.charCodeAt(0)) & 0xffffffff;
    return colors[Math.abs(hash) % colors.length];
  }

  // ── Auth ────────────────────────────────────────────
  async _signIn() {
    try {
      await signInWithPopup(auth, new GoogleAuthProvider());
      // onAuthStateChanged handles the rest
    } catch (e) {
      if (e.code !== 'auth/popup-closed-by-user') {
        this._toast('サインインに失敗しました');
        console.error(e);
      }
    }
  }

  async _signOut() {
    if (!confirm('サインアウトしますか？')) return;
    await signOut(auth);
    // onAuthStateChanged will show login screen
  }

  // ── Event Binding ──────────────────────────────────
  _bindEvents() {
    // Login
    document.getElementById('btn-google-signin').addEventListener('click', () => this._signIn());

    // Header sign-out
    document.getElementById('btn-signout').addEventListener('click', () => this._signOut());

    // Library
    document.getElementById('btn-go-register').addEventListener('click',    () => this._showRegister());
    document.getElementById('btn-empty-register').addEventListener('click', () => this._showRegister());

    // Register screen
    document.getElementById('btn-register-back').addEventListener('click', async () => {
      await this._renderLibrary();
      this.showScreen('home');
    });
    const regDrop  = document.getElementById('register-drop-zone');
    const regInput = document.getElementById('register-file-input');
    regDrop.addEventListener('click',     () => regInput.click());
    regDrop.addEventListener('dragover',  e  => { e.preventDefault(); regDrop.classList.add('drag-over'); });
    regDrop.addEventListener('dragleave', ()  => regDrop.classList.remove('drag-over'));
    regDrop.addEventListener('drop', e => {
      e.preventDefault();
      regDrop.classList.remove('drag-over');
      const file = e.dataTransfer.files[0];
      if (file && (file.name.endsWith('.json') || file.name.endsWith('.xlsx'))) this._registerFile(file);
      else this._toast('JSON または Excel（.xlsx）ファイルをドロップしてください');
    });
    regInput.addEventListener('change', e => {
      if (e.target.files[0]) this._registerFile(e.target.files[0]);
      e.target.value = '';
    });

    // Exam screen
    document.getElementById('btn-exam-back').addEventListener('click', async () => {
      await this._renderLibrary();
      this.showScreen('home');
    });
    document.getElementById('btn-exam-stats').addEventListener('click', () => this._showStats());
    document.getElementById('btn-study').addEventListener('click', () => this._startMode('study'));
    document.getElementById('btn-weak').addEventListener('click',  () => this._startMode('weak'));
    document.getElementById('btn-mock').addEventListener('click',  () => this._startMode('mock'));

    // Count preset buttons
    document.querySelectorAll('.count-btn').forEach(btn => {
      btn.addEventListener('click', () => {
        document.querySelectorAll('.count-btn').forEach(b => b.classList.remove('active'));
        btn.classList.add('active');
        document.getElementById('q-count-input').value = btn.dataset.count;
      });
    });
    document.getElementById('q-count-input').addEventListener('input', e => {
      const val = parseInt(e.target.value, 10);
      document.querySelectorAll('.count-btn').forEach(b => {
        b.classList.toggle('active', parseInt(b.dataset.count) === val);
      });
    });

    // Quiz
    document.getElementById('btn-next').addEventListener('click', () => this._nextQuestion());
    document.getElementById('btn-quit').addEventListener('click', () => this._quitQuiz());

    // Result
    document.getElementById('btn-result-home').addEventListener('click', async () => {
      await this._renderLibrary();
      this.showScreen('home');
    });
    document.getElementById('btn-retry').addEventListener('click',        () => this._startMode(this.session.mode));
    document.getElementById('btn-review-wrongs').addEventListener('click', () => this._reviewWrongs());
    document.getElementById('tab-wrong').addEventListener('click', () => this._showTab('wrong'));
    document.getElementById('tab-all').addEventListener('click',   () => this._showTab('all'));

    // Excel template download
    document.getElementById('btn-download-template').addEventListener('click', () => this._downloadExcelTemplate());

    // Stats
    document.getElementById('btn-reset-stats').addEventListener('click', () => this._resetStats());
    document.getElementById('btn-stats-back').addEventListener('click',  async () => {
      await this._renderExamCard();
      this.showScreen('exam');
    });
  }

  // ── Library Screen ─────────────────────────────────
  async _renderLibrary() {
    if (!this.currentUser) return;
    const uid = this.currentUser.uid;

    const exams = await this.storage.getRegisteredExams();
    this._cachedExams = exams;

    const grid  = document.getElementById('library-grid');
    const empty = document.getElementById('library-empty');
    grid.innerHTML = '';

    if (exams.length === 0) {
      empty.style.display = '';
      grid.style.display  = 'none';
      return;
    }

    empty.style.display = 'none';
    grid.style.display  = '';

    // Load stats for all exams in parallel
    const statsArr = await Promise.all(
      exams.map(e => this.storage.getExamStats(uid, e.meta.id).catch(() => ({ questions: {}, sessions: [] })))
    );

    exams.forEach((exam, idx) => {
      const stats    = statsArr[idx];
      const sessions = stats.sessions || [];
      const qStats   = stats.questions || {};
      const answered = Object.values(qStats).filter(s => s.total > 0);
      const avgAcc   = answered.length > 0
        ? Math.round(answered.reduce((sum, s) => sum + s.correct / s.total, 0) / answered.length * 100)
        : null;
      const weakCount    = Object.entries(qStats).filter(([, s]) => s.total > 0 && (s.correct / s.total) < 0.7).length;
      const accuracyClass = avgAcc === null ? '' : avgAcc >= 80 ? 'high' : avgAcc >= 60 ? 'mid' : 'low';

      const card = document.createElement('div');
      card.className = 'library-card';
      card.innerHTML = `
        <div class="library-card-name">${exam.meta.name}</div>
        <div class="library-card-desc">${exam.meta.description || '説明なし'}</div>
        <div class="library-card-badges">
          <span class="lib-badge">🗂 ${exam.questions.length}問</span>
          <span class="lib-badge">📝 ${sessions.length}回受験</span>
          ${avgAcc !== null
            ? `<span class="lib-badge accuracy-${accuracyClass}">✓ ${avgAcc}%</span>`
            : '<span class="lib-badge">未受験</span>'
          }
          ${weakCount > 0 ? `<span class="lib-badge weak">⚡ 苦手${weakCount}問</span>` : ''}
        </div>
        <div class="library-card-arrow">→</div>`;
      card.addEventListener('click', () => this._selectExam(exam.meta.id));
      grid.appendChild(card);
    });
  }

  // ── Register Screen ────────────────────────────────
  async _showRegister() {
    await this._renderRegisteredList();
    this.showScreen('register');
  }

  async _renderRegisteredList() {
    const list = document.getElementById('registered-list');
    list.innerHTML = '<div class="empty-state" style="padding:24px"><p>読み込み中…</p></div>';

    let exams;
    try {
      exams = await this.storage.getRegisteredExams();
    } catch (e) {
      list.innerHTML = '<div class="empty-state"><p>読み込みに失敗しました</p></div>';
      return;
    }

    list.innerHTML = '';
    if (exams.length === 0) {
      list.innerHTML = '<div class="empty-state" style="padding:24px"><p>登録された問題集がありません</p></div>';
      return;
    }

    for (const exam of exams) {
      const item = document.createElement('div');
      item.className = 'registered-item';
      item.innerHTML = `
        <div class="registered-item-info">
          <div class="registered-item-name">${exam.meta.name}</div>
          <div class="registered-item-meta">${exam.questions.length}問 / ID: ${exam.meta.id}</div>
        </div>
        <button class="btn btn-outline btn-sm btn-excel-export">⬇ Excel</button>
        <button class="btn btn-danger btn-sm btn-delete">削除</button>`;
      item.querySelector('.btn-excel-export').addEventListener('click', () => this._exportToExcel(exam));
      item.querySelector('.btn-delete').addEventListener('click', async () => {
        if (confirm(`「${exam.meta.name}」を削除しますか？`)) {
          try {
            await this.storage.deleteExam(exam.meta.id);
            this._cachedExams = null;
            this._toast(`「${exam.meta.name}」を削除しました`);
            await this._renderRegisteredList();
          } catch (e) {
            this._toast('削除に失敗しました');
          }
        }
      });
      list.appendChild(item);
    }
  }

  async _registerFile(file) {
    if (file.name.endsWith('.xlsx') || file.name.endsWith('.xls')) {
      await this._importExcel(file);
      return;
    }
    const reader = new FileReader();
    reader.onload = async (e) => {
      try {
        const data = JSON.parse(e.target.result);
        if (!data.meta || !data.meta.id || !Array.isArray(data.questions)) {
          this._toast('不正なJSONフォーマットです（meta.id と questions 配列が必要）');
          return;
        }
        await this.storage.registerExam(data);
        this._cachedExams = null;
        this._toast(`「${data.meta.name}」を登録しました（${data.questions.length}問）`);
        await this._renderRegisteredList();
      } catch (e) {
        if (e instanceof SyntaxError) this._toast('JSONの解析に失敗しました');
        else { this._toast('登録に失敗しました'); console.error(e); }
      }
    };
    reader.readAsText(file, 'UTF-8');
  }

  // ── Excel Import ───────────────────────────────────
  async _importExcel(file) {
    const XLSX = window.XLSX;
    if (!XLSX) { this._toast('Excel機能の読み込みに失敗しました'); return; }
    try {
      const buf  = await file.arrayBuffer();
      const wb   = XLSX.read(buf, { type: 'array' });

      // meta sheet
      const metaSheet = wb.Sheets['meta'];
      if (!metaSheet) { this._toast('"meta" シートが見つかりません'); return; }
      const metaRows = XLSX.utils.sheet_to_json(metaSheet);
      if (metaRows.length === 0) { this._toast('metaシートにデータがありません'); return; }
      const mr   = metaRows[0];
      const meta = {
        id:          String(mr.id          || '').trim(),
        name:        String(mr.name        || '').trim(),
        description: String(mr.description || '').trim(),
        timeLimit:   mr.timeLimit ? Number(mr.timeLimit) : null,
        version:     String(mr.version     || '1.0.0').trim(),
      };
      if (!meta.id) { this._toast('metaシートの id が空です'); return; }

      // questions sheet
      const qSheet = wb.Sheets['questions'];
      if (!qSheet) { this._toast('"questions" シートが見つかりません'); return; }
      const answerMap = { A: 0, B: 1, C: 2, D: 3 };
      const questions = XLSX.utils.sheet_to_json(qSheet)
        .filter(r => r.question)
        .map((r, i) => ({
          id:          Number(r.id) || (i + 1),
          category:    String(r.category    || '').trim(),
          question:    String(r.question    || '').trim(),
          choices:     [
            String(r.choiceA || '').trim(),
            String(r.choiceB || '').trim(),
            String(r.choiceC || '').trim(),
            String(r.choiceD || '').trim(),
          ],
          answer:      answerMap[String(r.answer || 'A').toUpperCase().trim()] ?? 0,
          explanation: String(r.explanation || '').trim(),
        }));

      if (questions.length === 0) { this._toast('questionsシートに問題がありません'); return; }

      await this.storage.registerExam({ meta, questions });
      this._cachedExams = null;
      this._toast(`「${meta.name}」を登録しました（${questions.length}問）`);
      await this._renderRegisteredList();
    } catch (e) {
      this._toast('Excelの読み込みに失敗しました');
      console.error(e);
    }
  }

  // ── Excel Export ───────────────────────────────────
  _exportToExcel(exam) {
    const XLSX = window.XLSX;
    if (!XLSX) { this._toast('Excel機能の読み込みに失敗しました'); return; }
    const { meta, questions } = exam;
    const wb = XLSX.utils.book_new();

    // meta sheet
    XLSX.utils.book_append_sheet(wb,
      XLSX.utils.json_to_sheet([{
        id: meta.id, name: meta.name,
        description: meta.description || '',
        timeLimit: meta.timeLimit || '',
        version: meta.version || '1.0.0',
      }]),
      'meta'
    );

    // questions sheet
    const letters = ['A', 'B', 'C', 'D'];
    XLSX.utils.book_append_sheet(wb,
      XLSX.utils.json_to_sheet(questions.map(q => ({
        id:          q.id,
        category:    q.category,
        question:    q.question,
        choiceA:     q.choices[0] || '',
        choiceB:     q.choices[1] || '',
        choiceC:     q.choices[2] || '',
        choiceD:     q.choices[3] || '',
        answer:      letters[q.answer] || 'A',
        explanation: q.explanation || '',
      }))),
      'questions'
    );

    XLSX.writeFile(wb, `${meta.id}.xlsx`);
    this._toast(`「${meta.name}」をExcelでダウンロードしました`);
  }

  // ── Excel Template Download ────────────────────────
  _downloadExcelTemplate() {
    const XLSX = window.XLSX;
    if (!XLSX) { this._toast('Excel機能の読み込みに失敗しました'); return; }
    const wb = XLSX.utils.book_new();

    XLSX.utils.book_append_sheet(wb,
      XLSX.utils.json_to_sheet([{
        id: 'my_exam', name: '問題集名', description: '問題集の説明',
        timeLimit: 60, version: '1.0.0',
      }]),
      'meta'
    );

    XLSX.utils.book_append_sheet(wb,
      XLSX.utils.json_to_sheet([
        { id: 1, category: 'カテゴリ名', question: '問題文をここに入力',
          choiceA: '選択肢A', choiceB: '選択肢B', choiceC: '選択肢C', choiceD: '選択肢D',
          answer: 'A', explanation: '解説文をここに入力' },
        { id: 2, category: 'カテゴリ名', question: '2問目の問題文',
          choiceA: '選択肢A', choiceB: '選択肢B', choiceC: '選択肢C', choiceD: '選択肢D',
          answer: 'B', explanation: '解説文' },
      ]),
      'questions'
    );

    XLSX.writeFile(wb, 'question_template.xlsx');
    this._toast('テンプレートをダウンロードしました');
  }

  // ── Exam Detail Screen ─────────────────────────────
  async _selectExam(examId) {
    const examData = this._cachedExams?.find(e => e.meta.id === examId)
      || await this.storage.getExamById(examId);
    if (!examData) { this._toast('問題集が見つかりません'); return; }
    this.exam = examData;
    await this._renderExamCard();
    this._resetCountSelector();
    this.showScreen('exam');
  }

  async _renderExamCard() {
    if (!this.exam || !this.currentUser) return;
    const { meta, questions } = this.exam;
    const uid    = this.currentUser.uid;
    const stats  = await this.storage.getExamStats(uid, meta.id);
    const sessions = stats.sessions || [];
    const qStats   = stats.questions || {};
    const answered = Object.values(qStats).filter(s => s.total > 0);
    const avgAcc   = answered.length > 0
      ? Math.round(answered.reduce((sum, s) => sum + s.correct / s.total, 0) / answered.length * 100)
      : '--';

    document.getElementById('exam-name').textContent   = meta.name;
    document.getElementById('exam-desc').textContent   = meta.description || '';
    document.getElementById('exam-q-count').textContent = `${questions.length}問`;
    document.getElementById('exam-time').textContent   = meta.timeLimit ? `${meta.timeLimit}分` : '無制限';
    document.getElementById('stat-sessions').textContent = sessions.length;
    document.getElementById('stat-accuracy').textContent = avgAcc === '--' ? '--' : `${avgAcc}%`;

    const weakIds = Object.entries(qStats)
      .filter(([, s]) => s.total > 0 && (s.correct / s.total) < 0.7).map(([id]) => id);
    document.getElementById('stat-weak').textContent = weakIds.length;
    document.getElementById('weak-mode-desc').textContent =
      weakIds.length === 0 ? '（学習後に利用できます）' : `正答率70%未満の${weakIds.length}問を集中練習`;
  }

  _resetCountSelector() {
    document.querySelectorAll('.count-btn').forEach(b => {
      b.classList.toggle('active', b.dataset.count === '30');
    });
    document.getElementById('q-count-input').value = '30';
  }

  // ── Start Mode ─────────────────────────────────────
  async _startMode(mode) {
    if (!this.exam || !this.currentUser) return;
    const { meta, questions } = this.exam;
    const uid = this.currentUser.uid;
    let quizQuestions = [...questions];

    if (mode === 'weak') {
      const weakIds = await this.storage.getWeakQuestionIds(uid, meta.id);
      if (weakIds.length === 0) {
        this._toast('苦手問題がありません。まず学習モードで解いてください');
        return;
      }
      quizQuestions = questions.filter(q => weakIds.includes(String(q.id)));
    }

    quizQuestions = this._shuffle(quizQuestions);

    const limitVal = parseInt(document.getElementById('q-count-input').value, 10);
    if (limitVal > 0 && limitVal < quizQuestions.length) quizQuestions = quizQuestions.slice(0, limitVal);

    quizQuestions = quizQuestions.map(q => this._shuffleChoices(q));

    this.session = new QuizSession({
      questions: quizQuestions,
      mode,
      examId: meta.id,
      timeLimit: mode === 'mock' ? (meta.timeLimit || 60) : null,
    });

    this._startQuiz();
  }

  _shuffleChoices(q) {
    const indexed = q.choices.map((text, i) => ({ text, origIdx: i }));
    for (let j = indexed.length - 1; j > 0; j--) {
      const k = Math.floor(Math.random() * (j + 1));
      [indexed[j], indexed[k]] = [indexed[k], indexed[j]];
    }
    return { ...q, choices: indexed.map(x => x.text), answer: indexed.findIndex(x => x.origIdx === q.answer) };
  }

  _shuffle(arr) {
    const a = [...arr];
    for (let i = a.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [a[i], a[j]] = [a[j], a[i]];
    }
    return a;
  }

  // ── Quiz Screen ────────────────────────────────────
  _startQuiz() {
    clearInterval(this.timerInterval);
    this.showScreen('quiz');
    document.getElementById('quiz-mode-label').textContent =
      ({ study: '学習モード', weak: '苦手問題', mock: '模擬試験' })[this.session.mode] || '';

    if (this.session.timeLimitSec !== null) {
      document.getElementById('timer-wrap').style.display = '';
      this.timerInterval = setInterval(() => this._tickTimer(), 1000);
      this._renderTimer();
    } else {
      document.getElementById('timer-wrap').style.display = 'none';
    }
    this._renderQuestion();
  }

  _tickTimer() {
    this._renderTimer();
    if (this.session.remainingSec <= 0) { clearInterval(this.timerInterval); this._finishQuiz(); }
  }

  _renderTimer() {
    const sec  = this.session.remainingSec;
    const min  = Math.floor(sec / 60);
    const s    = sec % 60;
    document.getElementById('timer-display').textContent =
      `${String(min).padStart(2,'0')}:${String(s).padStart(2,'0')}`;
    const wrap = document.getElementById('timer-wrap');
    wrap.className = 'timer';
    if (sec <= 60) wrap.classList.add('danger');
    else if (sec <= 300) wrap.classList.add('warning');
  }

  _renderQuestion() {
    const sess = this.session;
    if (sess.isDone) { this._finishQuiz(); return; }
    const q = sess.current;

    document.getElementById('progress-fill').style.width = `${Math.round((sess.currentIndex / sess.total) * 100)}%`;
    document.getElementById('progress-text').textContent = `${sess.currentIndex + 1} / ${sess.total}`;
    document.getElementById('q-category').textContent    = q.category || '';
    document.getElementById('q-text').textContent        = q.question;

    const choiceLabels = ['A','B','C','D'];
    const choiceWrap   = document.getElementById('choices-wrap');
    choiceWrap.innerHTML = '';
    q.choices.forEach((text, i) => {
      const btn = document.createElement('button');
      btn.className = 'choice-btn';
      btn.innerHTML = `<span class="choice-label">${choiceLabels[i]}</span><span>${text}</span>`;
      btn.addEventListener('click', () => this._selectChoice(i));
      choiceWrap.appendChild(btn);
    });

    document.getElementById('feedback').className    = 'feedback';
    document.getElementById('feedback').style.display = 'none';
    document.getElementById('btn-next').style.display = 'none';
  }

  _selectChoice(index) {
    if (this.session.answered) return;
    const isCorrect = this.session.submitAnswer(index);

    const buttons      = document.querySelectorAll('.choice-btn');
    const correctIndex = this.session.current.answer;
    buttons.forEach((btn, i) => {
      btn.disabled = true;
      if (i === correctIndex) btn.classList.add('correct');
      else if (i === index && !isCorrect) btn.classList.add('incorrect');
    });

    if (this.session.mode !== 'mock') {
      const q  = this.session.current;
      const fb = document.getElementById('feedback');
      fb.style.display = '';
      fb.className = `feedback show ${isCorrect ? 'correct-fb' : 'incorrect-fb'}`;
      document.getElementById('fb-title').textContent       = isCorrect ? '✓ 正解！' : '✗ 不正解';
      document.getElementById('fb-explanation').textContent = q.explanation || '';
    }

    document.getElementById('btn-next').style.display = '';
    document.getElementById('btn-next').textContent =
      this.session.currentIndex + 1 >= this.session.total ? '結果を見る' : '次の問題 →';
  }

  _nextQuestion() {
    this.session.next();
    if (this.session.isDone) this._finishQuiz(); else this._renderQuestion();
  }

  async _quitQuiz() {
    if (!confirm('試験を中断しますか？（解答済みの進捗は保存されています）')) return;
    clearInterval(this.timerInterval);
    if (this.session.answers.length > 0) await this._finishQuiz(); else this.showScreen('exam');
  }

  // ── Results ────────────────────────────────────────
  async _finishQuiz() {
    clearInterval(this.timerInterval);
    const results   = this.session.getResults();
    this.lastResults = results;

    try {
      await this.storage.recordSessionResults(
        this.currentUser.uid,
        this.exam.meta.id,
        results.answers,
        { mode: results.mode, score: results.score, correct: results.correct,
          total: results.total, durationSec: results.durationSec }
      );
    } catch (e) {
      console.error('Failed to save results:', e);
      this._toast('結果の保存に失敗しました');
    }

    this._renderResults(results);
    this.showScreen('result');
  }

  _renderResults(results) {
    const { score, correct, total, categories, wrongAnswers } = results;

    document.getElementById('result-score').textContent  = `${score}%`;
    document.getElementById('result-detail').textContent = `${correct} / ${total} 問正解`;

    const passEl = document.getElementById('pass-badge');
    passEl.textContent = score >= 70 ? '合格ライン達成！' : '合格ラインまで頑張ろう';
    passEl.className   = `pass-badge ${score >= 70 ? 'pass' : 'fail'}`;

    const min = Math.floor(results.durationSec / 60);
    const sec = results.durationSec % 60;
    document.getElementById('result-time').textContent = `解答時間: ${min}分${sec}秒`;

    const catList = document.getElementById('category-list');
    catList.innerHTML = '';
    for (const c of categories) {
      const colorClass = c.pct >= 80 ? 'high' : c.pct >= 60 ? 'mid' : 'low';
      catList.innerHTML += `
        <div class="category-item">
          <span class="category-name">${c.name}</span>
          <div class="category-bar-wrap">
            <div class="category-bar-fill ${colorClass}" style="width:${c.pct}%"></div>
          </div>
          <span class="category-pct">${c.pct}%</span>
        </div>`;
    }

    this._renderReviewList('wrong');
    document.getElementById('tab-wrong').classList.add('active');
    document.getElementById('tab-all').classList.remove('active');

    const btnReview = document.getElementById('btn-review-wrongs');
    btnReview.style.display = wrongAnswers.length > 0 ? '' : 'none';
    if (wrongAnswers.length > 0) btnReview.textContent = `🔁 間違えた${wrongAnswers.length}問を復習`;
  }

  _showTab(tab) {
    document.querySelectorAll('.tab-btn').forEach(b => b.classList.remove('active'));
    document.getElementById(`tab-${tab}`).classList.add('active');
    this._renderReviewList(tab);
  }

  _renderReviewList(filter) {
    const answers = filter === 'wrong'
      ? this.lastResults.answers.filter(a => !a.isCorrect)
      : this.lastResults.answers;

    const list = document.getElementById('review-list');
    list.innerHTML = '';
    if (answers.length === 0) {
      list.innerHTML = '<div class="empty-state"><div class="empty-icon">🎉</div><p>間違えた問題はありません</p></div>';
      return;
    }
    const choiceLabels = ['A','B','C','D'];
    for (const a of answers) {
      const el = document.createElement('div');
      el.className = `review-item ${a.isCorrect ? 'right' : 'wrong'}`;
      el.innerHTML = `
        <div class="review-item-header">
          <span class="tag tag-category">${a.category}</span>
          <span class="tag ${a.isCorrect ? 'tag-right' : 'tag-wrong'}">${a.isCorrect ? '正解' : '不正解'}</span>
        </div>
        <div class="review-q">${a.question}</div>
        <div class="review-answer">
          あなたの回答: ${choiceLabels[a.selectedAnswer]}. ${a.choices[a.selectedAnswer]}<br>
          ${!a.isCorrect ? `正解: ${choiceLabels[a.correctAnswer]}. ${a.choices[a.correctAnswer]}` : ''}
        </div>
        <div class="review-explanation">${a.explanation || ''}</div>`;
      list.appendChild(el);
    }
  }

  _reviewWrongs() {
    if (!this.lastResults || this.lastResults.wrongAnswers.length === 0) return;
    const wrongIds = new Set(this.lastResults.wrongAnswers.map(a => String(a.questionId)));
    const originals = this.exam.questions.filter(q => wrongIds.has(String(q.id)));
    const questions = this._shuffle(originals).map(q => this._shuffleChoices(q));
    this.session = new QuizSession({ questions, mode: 'study', examId: this.exam.meta.id });
    this._startQuiz();
  }

  // ── Stats Screen ───────────────────────────────────
  async _showStats() {
    if (!this.exam || !this.currentUser) return;
    const uid   = this.currentUser.uid;
    const stats = await this.storage.getExamStats(uid, this.exam.meta.id);

    document.getElementById('stats-exam-name').textContent = this.exam.meta.name;

    const list = document.getElementById('q-stats-list');
    list.innerHTML = '';
    for (const q of this.exam.questions) {
      const s       = stats.questions[String(q.id)];
      const total   = s ? s.total : 0;
      const correct = s ? s.correct : 0;
      const pct     = total > 0 ? Math.round((correct / total) * 100) : null;
      const pctClass = pct === null ? '' : pct >= 80 ? 'high' : pct >= 60 ? 'mid' : 'low';
      const el = document.createElement('div');
      el.className = 'q-stat-item';
      el.innerHTML = `
        <span class="q-stat-id">#${q.id}</span>
        <span class="q-stat-q">${q.question.slice(0, 40)}${q.question.length > 40 ? '…' : ''}</span>
        <span class="q-stat-accuracy ${pctClass}">${pct === null ? '--' : pct + '%'}</span>
        <span class="q-stat-attempts">${total}回</span>`;
      list.appendChild(el);
    }

    const sessions    = stats.sessions || [];
    const sessionList = document.getElementById('session-list');
    sessionList.innerHTML = '';
    if (sessions.length === 0) {
      sessionList.innerHTML = '<div class="empty-state"><p>セッション履歴がありません</p></div>';
    } else {
      const modeLabels = { study: '学習', weak: '苦手問題', mock: '模擬試験' };
      [...sessions].reverse().slice(0, 20).forEach(s => {
        const d = new Date(s.date);
        const dateStr = `${d.getFullYear()}/${d.getMonth()+1}/${d.getDate()} ${String(d.getHours()).padStart(2,'0')}:${String(d.getMinutes()).padStart(2,'0')}`;
        const pct = Math.round(s.score);
        const pctClass = pct >= 80 ? 'high' : pct >= 60 ? 'mid' : 'low';
        const el = document.createElement('div');
        el.className = 'q-stat-item';
        el.innerHTML = `
          <span class="q-stat-id">${dateStr}</span>
          <span class="q-stat-q">${modeLabels[s.mode] || s.mode}</span>
          <span class="q-stat-accuracy ${pctClass}">${pct}%</span>
          <span class="q-stat-attempts">${s.correct ?? '?'}/${s.total}</span>`;
        sessionList.appendChild(el);
      });
    }
    this.showScreen('stats');
  }

  async _resetStats() {
    if (!this.exam || !this.currentUser) return;
    if (!confirm('この試験の学習データをすべてリセットしますか？')) return;
    try {
      await this.storage.clearExamStats(this.currentUser.uid, this.exam.meta.id);
      this._toast('学習データをリセットしました');
      await this._renderExamCard();
      await this._showStats();
    } catch (e) {
      this._toast('リセットに失敗しました');
    }
  }

  // ── Toast ──────────────────────────────────────────
  _toast(message, duration = 2500) {
    const toast = document.getElementById('toast');
    toast.textContent = message;
    toast.classList.add('show');
    setTimeout(() => toast.classList.remove('show'), duration);
  }
}

document.addEventListener('DOMContentLoaded', () => { window.app = new App(); });
