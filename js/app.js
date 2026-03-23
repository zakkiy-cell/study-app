'use strict';

// ===== Storage Manager =====
class StorageManager {
  constructor() {
    this.USERS_KEY  = 'studyApp_users';
    this.EXAMS_KEY  = 'studyApp_exams';
  }

  // ── User Management ───────────────────────────────
  getUsers() {
    try { return JSON.parse(localStorage.getItem(this.USERS_KEY) || '[]'); }
    catch { return []; }
  }

  addUser(name) {
    const users = this.getUsers();
    const user = { id: `user_${Date.now()}`, name: name.trim(), createdAt: new Date().toISOString() };
    users.push(user);
    localStorage.setItem(this.USERS_KEY, JSON.stringify(users));
    return user;
  }

  deleteUser(userId) {
    const users = this.getUsers().filter(u => u.id !== userId);
    localStorage.setItem(this.USERS_KEY, JSON.stringify(users));
    // Remove user stats
    localStorage.removeItem(this._statsKey(userId));
  }

  // ── Exam Library ──────────────────────────────────
  getRegisteredExams() {
    try { return JSON.parse(localStorage.getItem(this.EXAMS_KEY) || '[]'); }
    catch { return []; }
  }

  getExamById(examId) {
    return this.getRegisteredExams().find(e => e.meta.id === examId) || null;
  }

  registerExam(data) {
    const exams = this.getRegisteredExams();
    const idx = exams.findIndex(e => e.meta.id === data.meta.id);
    if (idx >= 0) exams[idx] = data; else exams.push(data);
    localStorage.setItem(this.EXAMS_KEY, JSON.stringify(exams));
  }

  deleteExam(examId) {
    const exams = this.getRegisteredExams().filter(e => e.meta.id !== examId);
    localStorage.setItem(this.EXAMS_KEY, JSON.stringify(exams));
  }

  // ── Per-User Stats ────────────────────────────────
  _statsKey(userId) { return `studyApp_stats_${userId}`; }

  _loadStats(userId) {
    try { return JSON.parse(localStorage.getItem(this._statsKey(userId)) || '{}'); }
    catch { return {}; }
  }

  _saveStats(userId, data) {
    localStorage.setItem(this._statsKey(userId), JSON.stringify(data));
  }

  getExamStats(userId, examId) {
    const data = this._loadStats(userId);
    return data[examId] || { questions: {}, sessions: [] };
  }

  recordAnswer(userId, examId, questionId, isCorrect) {
    const data = this._loadStats(userId);
    if (!data[examId]) data[examId] = { questions: {}, sessions: [] };
    const stats = data[examId].questions;
    const key = String(questionId);
    if (!stats[key]) stats[key] = { correct: 0, total: 0 };
    stats[key].total++;
    if (isCorrect) stats[key].correct++;
    this._saveStats(userId, data);
  }

  recordSession(userId, examId, session) {
    const data = this._loadStats(userId);
    if (!data[examId]) data[examId] = { questions: {}, sessions: [] };
    data[examId].sessions.push({
      date: new Date().toISOString(),
      mode: session.mode,
      score: session.score,
      correct: session.correct,
      total: session.total,
      durationSec: session.durationSec,
    });
    if (data[examId].sessions.length > 50) {
      data[examId].sessions = data[examId].sessions.slice(-50);
    }
    this._saveStats(userId, data);
  }

  getWeakQuestionIds(userId, examId, threshold = 0.7) {
    const stats = this.getExamStats(userId, examId);
    return Object.entries(stats.questions)
      .filter(([, s]) => s.total > 0 && (s.correct / s.total) < threshold)
      .map(([id]) => id);
  }

  clearExamStats(userId, examId) {
    const data = this._loadStats(userId);
    delete data[examId];
    this._saveStats(userId, data);
  }

  // Total sessions across all exams for a user (for user card summary)
  getTotalSessions(userId) {
    const data = this._loadStats(userId);
    return Object.values(data).reduce((sum, d) => sum + (d.sessions || []).length, 0);
  }

  getLastSessionDate(userId) {
    const data = this._loadStats(userId);
    const allDates = Object.values(data)
      .flatMap(d => (d.sessions || []).map(s => s.date))
      .sort();
    return allDates.length > 0 ? allDates[allDates.length - 1] : null;
  }
}

// ===== Quiz Session =====
class QuizSession {
  constructor({ questions, mode, examId, timeLimit = null }) {
    this.questions = questions;
    this.mode = mode;
    this.examId = examId;
    this.timeLimitSec = timeLimit ? timeLimit * 60 : null;
    this.currentIndex = 0;
    this.answers = [];
    this.startTime = Date.now();
    this.answered = false;
  }

  get current() { return this.questions[this.currentIndex]; }
  get total() { return this.questions.length; }
  get isDone() { return this.currentIndex >= this.total; }
  get elapsedSec() { return Math.floor((Date.now() - this.startTime) / 1000); }
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
    const total = this.answers.length;
    const score = total > 0 ? Math.round((correct / total) * 100) : 0;
    const cats = {};
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
    this.storage = new StorageManager();
    this.currentUser = null;
    this.exam = null;
    this.session = null;
    this.timerInterval = null;
    this.lastResults = null;
    this._init();
  }

  _init() {
    this._bindEvents();
    this.showScreen('user');
    this._renderUserScreen();
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
    document.getElementById('current-user-name').textContent = this.currentUser.name;
    document.getElementById('user-indicator-avatar').textContent =
      this.currentUser.name.charAt(0).toUpperCase();
    document.getElementById('user-indicator-avatar').style.background =
      this._userColor(this.currentUser.id);
  }

  _userColor(userId) {
    const colors = ['#4F46E5','#7C3AED','#DB2777','#DC2626','#D97706','#059669','#0891B2','#1D4ED8'];
    let hash = 0;
    for (const c of userId) hash = (hash * 31 + c.charCodeAt(0)) & 0xffffffff;
    return colors[Math.abs(hash) % colors.length];
  }

  // ── Event Binding ──────────────────────────────────
  _bindEvents() {
    // User screen
    document.getElementById('btn-add-user').addEventListener('click', () => this._addUser());
    document.getElementById('new-user-name').addEventListener('keydown', e => {
      if (e.key === 'Enter') this._addUser();
    });
    document.getElementById('btn-switch-user').addEventListener('click', () => {
      this.currentUser = null;
      this._updateUserIndicator();
      this._renderUserScreen();
      this.showScreen('user');
    });

    // Library
    document.getElementById('btn-go-register').addEventListener('click', () => this._showRegister());
    document.getElementById('btn-empty-register').addEventListener('click', () => this._showRegister());

    // Register screen
    document.getElementById('btn-register-back').addEventListener('click', () => {
      this._renderLibrary();
      this.showScreen('home');
    });
    const regDrop = document.getElementById('register-drop-zone');
    const regInput = document.getElementById('register-file-input');
    regDrop.addEventListener('click', () => regInput.click());
    regDrop.addEventListener('dragover', e => { e.preventDefault(); regDrop.classList.add('drag-over'); });
    regDrop.addEventListener('dragleave', () => regDrop.classList.remove('drag-over'));
    regDrop.addEventListener('drop', e => {
      e.preventDefault();
      regDrop.classList.remove('drag-over');
      const file = e.dataTransfer.files[0];
      if (file && file.name.endsWith('.json')) this._registerFile(file);
      else this._toast('JSONファイルをドロップしてください');
    });
    regInput.addEventListener('change', e => {
      if (e.target.files[0]) this._registerFile(e.target.files[0]);
      e.target.value = '';
    });

    // Exam screen
    document.getElementById('btn-exam-back').addEventListener('click', () => {
      this._renderLibrary();
      this.showScreen('home');
    });
    document.getElementById('btn-exam-stats').addEventListener('click', () => this._showStats());
    document.getElementById('btn-study').addEventListener('click', () => this._startMode('study'));
    document.getElementById('btn-weak').addEventListener('click', () => this._startMode('weak'));
    document.getElementById('btn-mock').addEventListener('click', () => this._startMode('mock'));

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
    document.getElementById('btn-result-home').addEventListener('click', () => {
      this._renderExamCard();
      this._renderLibrary();
      this.showScreen('home');
    });
    document.getElementById('btn-retry').addEventListener('click', () => this._retryMode());
    document.getElementById('btn-review-wrongs').addEventListener('click', () => this._reviewWrongs());
    document.getElementById('tab-wrong').addEventListener('click', () => this._showTab('wrong'));
    document.getElementById('tab-all').addEventListener('click', () => this._showTab('all'));

    // Stats
    document.getElementById('btn-reset-stats').addEventListener('click', () => this._resetStats());
    document.getElementById('btn-stats-back').addEventListener('click', () => this.showScreen('exam'));
  }

  // ── User Screen ────────────────────────────────────
  _renderUserScreen() {
    const users = this.storage.getUsers();
    const grid = document.getElementById('user-grid');
    grid.innerHTML = '';

    for (const user of users) {
      const totalSessions = this.storage.getTotalSessions(user.id);
      const lastDate = this.storage.getLastSessionDate(user.id);
      const lastText = lastDate ? this._relativeDate(lastDate) : '未使用';
      const color = this._userColor(user.id);
      const initial = user.name.charAt(0).toUpperCase();

      const card = document.createElement('div');
      card.className = 'user-card';
      card.innerHTML = `
        <div class="user-card-avatar" style="background:${color}">${initial}</div>
        <div class="user-card-info">
          <div class="user-card-name">${user.name}</div>
          <div class="user-card-meta">
            ${totalSessions > 0 ? `📝 ${totalSessions}回受験` : '受験履歴なし'}
            ${lastDate ? `・最終: ${lastText}` : ''}
          </div>
        </div>
        <button class="user-delete-btn" data-id="${user.id}" title="削除">✕</button>
      `;

      // Click card body → select user
      card.addEventListener('click', e => {
        if (e.target.closest('.user-delete-btn')) return;
        this._selectUser(user);
      });

      // Delete button
      card.querySelector('.user-delete-btn').addEventListener('click', e => {
        e.stopPropagation();
        if (confirm(`「${user.name}」を削除しますか？\n学習履歴もすべて削除されます。`)) {
          this.storage.deleteUser(user.id);
          this._toast(`「${user.name}」を削除しました`);
          this._renderUserScreen();
        }
      });

      grid.appendChild(card);
    }

    // Show/hide welcome text based on user count
    document.querySelector('.user-welcome p').textContent =
      users.length > 0
        ? 'ユーザーを選択するか、新しいユーザーを追加してください'
        : '最初にユーザーを作成してください';
  }

  _addUser() {
    const input = document.getElementById('new-user-name');
    const name = input.value.trim();
    if (!name) { this._toast('名前を入力してください'); input.focus(); return; }
    if (name.length > 20) { this._toast('名前は20文字以内で入力してください'); return; }
    const users = this.storage.getUsers();
    if (users.some(u => u.name === name)) {
      this._toast(`「${name}」はすでに登録されています`);
      return;
    }
    const user = this.storage.addUser(name);
    input.value = '';
    this._toast(`「${user.name}」を追加しました`);
    this._renderUserScreen();
  }

  _selectUser(user) {
    this.currentUser = user;
    this._updateUserIndicator();
    this._renderLibrary();
    this.showScreen('home');
  }

  _relativeDate(isoString) {
    const diff = Date.now() - new Date(isoString).getTime();
    const days = Math.floor(diff / (1000 * 60 * 60 * 24));
    if (days === 0) return '今日';
    if (days === 1) return '昨日';
    if (days < 7) return `${days}日前`;
    if (days < 30) return `${Math.floor(days / 7)}週間前`;
    return `${Math.floor(days / 30)}ヶ月前`;
  }

  // ── Library Screen ─────────────────────────────────
  _renderLibrary() {
    if (!this.currentUser) return;
    const exams = this.storage.getRegisteredExams();
    const grid = document.getElementById('library-grid');
    const empty = document.getElementById('library-empty');

    grid.innerHTML = '';

    if (exams.length === 0) {
      empty.style.display = '';
      grid.style.display = 'none';
      return;
    }

    empty.style.display = 'none';
    grid.style.display = '';

    for (const exam of exams) {
      const stats = this.storage.getExamStats(this.currentUser.id, exam.meta.id);
      const sessions = stats.sessions || [];
      const qStats = stats.questions || {};
      const answered = Object.values(qStats).filter(s => s.total > 0);
      const avgAccuracy = answered.length > 0
        ? Math.round(answered.reduce((sum, s) => sum + s.correct / s.total, 0) / answered.length * 100)
        : null;
      const weakCount = this.storage.getWeakQuestionIds(this.currentUser.id, exam.meta.id).length;
      const accuracyClass = avgAccuracy === null ? '' : avgAccuracy >= 80 ? 'high' : avgAccuracy >= 60 ? 'mid' : 'low';

      const card = document.createElement('div');
      card.className = 'library-card';
      card.innerHTML = `
        <div class="library-card-name">${exam.meta.name}</div>
        <div class="library-card-desc">${exam.meta.description || '説明なし'}</div>
        <div class="library-card-badges">
          <span class="lib-badge">🗂 ${exam.questions.length}問</span>
          <span class="lib-badge">📝 ${sessions.length}回受験</span>
          ${avgAccuracy !== null
            ? `<span class="lib-badge accuracy-${accuracyClass}">✓ ${avgAccuracy}%</span>`
            : '<span class="lib-badge">未受験</span>'
          }
          ${weakCount > 0 ? `<span class="lib-badge weak">⚡ 苦手${weakCount}問</span>` : ''}
        </div>
        <div class="library-card-arrow">→</div>
      `;
      card.addEventListener('click', () => this._selectExam(exam.meta.id));
      grid.appendChild(card);
    }
  }

  // ── Register Screen ────────────────────────────────
  _showRegister() {
    this._renderRegisteredList();
    this.showScreen('register');
  }

  _renderRegisteredList() {
    const exams = this.storage.getRegisteredExams();
    const list = document.getElementById('registered-list');
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
        <button class="btn btn-danger btn-sm">削除</button>
      `;
      item.querySelector('button').addEventListener('click', () => {
        if (confirm(`「${exam.meta.name}」を削除しますか？`)) {
          this.storage.deleteExam(exam.meta.id);
          this._toast(`「${exam.meta.name}」を削除しました`);
          this._renderRegisteredList();
        }
      });
      list.appendChild(item);
    }
  }

  _registerFile(file) {
    const reader = new FileReader();
    reader.onload = e => {
      try {
        const data = JSON.parse(e.target.result);
        if (!data.meta || !data.meta.id || !Array.isArray(data.questions)) {
          this._toast('不正なJSONフォーマットです（meta.id と questions 配列が必要）');
          return;
        }
        this.storage.registerExam(data);
        this._toast(`「${data.meta.name}」を登録しました（${data.questions.length}問）`);
        this._renderRegisteredList();
      } catch {
        this._toast('JSONの解析に失敗しました');
      }
    };
    reader.readAsText(file, 'UTF-8');
  }

  // ── Exam Detail Screen ─────────────────────────────
  _selectExam(examId) {
    const examData = this.storage.getExamById(examId);
    if (!examData) { this._toast('問題集が見つかりません'); return; }
    this.exam = examData;
    this._renderExamCard();
    this._resetCountSelector();
    this.showScreen('exam');
  }

  _renderExamCard() {
    if (!this.exam || !this.currentUser) return;
    const { meta, questions } = this.exam;
    const uid = this.currentUser.id;
    const stats = this.storage.getExamStats(uid, meta.id);
    const sessions = stats.sessions || [];
    const qStats = stats.questions || {};
    const answered = Object.values(qStats).filter(s => s.total > 0);
    const avgAccuracy = answered.length > 0
      ? Math.round(answered.reduce((sum, s) => sum + s.correct / s.total, 0) / answered.length * 100)
      : '--';

    document.getElementById('exam-name').textContent = meta.name;
    document.getElementById('exam-desc').textContent = meta.description || '';
    document.getElementById('exam-q-count').textContent = `${questions.length}問`;
    document.getElementById('exam-time').textContent = meta.timeLimit ? `${meta.timeLimit}分` : '無制限';
    document.getElementById('stat-sessions').textContent = sessions.length;
    document.getElementById('stat-accuracy').textContent = avgAccuracy === '--' ? '--' : `${avgAccuracy}%`;

    const weakIds = this.storage.getWeakQuestionIds(uid, meta.id);
    document.getElementById('stat-weak').textContent = weakIds.length;
    document.getElementById('weak-mode-desc').textContent =
      weakIds.length === 0
        ? '（学習後に利用できます）'
        : `正答率70%未満の${weakIds.length}問を集中練習`;
  }

  _resetCountSelector() {
    document.querySelectorAll('.count-btn').forEach(b => {
      b.classList.toggle('active', b.dataset.count === '30');
    });
    document.getElementById('q-count-input').value = '30';
  }

  // ── Start Mode ─────────────────────────────────────
  _startMode(mode) {
    if (!this.exam || !this.currentUser) return;
    const { meta, questions } = this.exam;
    const uid = this.currentUser.id;
    let quizQuestions = [...questions];

    if (mode === 'weak') {
      const weakIds = this.storage.getWeakQuestionIds(uid, meta.id);
      if (weakIds.length === 0) {
        this._toast('苦手問題がありません。まず学習モードで解いてください');
        return;
      }
      quizQuestions = questions.filter(q => weakIds.includes(String(q.id)));
    }

    quizQuestions = this._shuffle(quizQuestions);

    const limitVal = parseInt(document.getElementById('q-count-input').value, 10);
    if (limitVal > 0 && limitVal < quizQuestions.length) {
      quizQuestions = quizQuestions.slice(0, limitVal);
    }

    // Shuffle choices for each question
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
    const sec = this.session.remainingSec;
    const min = Math.floor(sec / 60);
    const s = sec % 60;
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
    document.getElementById('q-category').textContent = q.category || '';
    document.getElementById('q-text').textContent = q.question;

    const choiceLabels = ['A', 'B', 'C', 'D'];
    const choiceWrap = document.getElementById('choices-wrap');
    choiceWrap.innerHTML = '';
    q.choices.forEach((text, i) => {
      const btn = document.createElement('button');
      btn.className = 'choice-btn';
      btn.innerHTML = `<span class="choice-label">${choiceLabels[i]}</span><span>${text}</span>`;
      btn.addEventListener('click', () => this._selectChoice(i));
      choiceWrap.appendChild(btn);
    });

    document.getElementById('feedback').className = 'feedback';
    document.getElementById('feedback').style.display = 'none';
    document.getElementById('btn-next').style.display = 'none';
  }

  _selectChoice(index) {
    if (this.session.answered) return;
    const isCorrect = this.session.submitAnswer(index);
    this.storage.recordAnswer(this.currentUser.id, this.exam.meta.id, this.session.current.id, isCorrect);

    const buttons = document.querySelectorAll('.choice-btn');
    const correctIndex = this.session.current.answer;
    buttons.forEach((btn, i) => {
      btn.disabled = true;
      if (i === correctIndex) btn.classList.add('correct');
      else if (i === index && !isCorrect) btn.classList.add('incorrect');
    });

    if (this.session.mode !== 'mock') {
      const q = this.session.current;
      const fb = document.getElementById('feedback');
      fb.style.display = '';
      fb.className = `feedback show ${isCorrect ? 'correct-fb' : 'incorrect-fb'}`;
      document.getElementById('fb-title').textContent = isCorrect ? '✓ 正解！' : '✗ 不正解';
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

  _quitQuiz() {
    if (!confirm('試験を中断しますか？（解答済みの進捗は保存されています）')) return;
    clearInterval(this.timerInterval);
    if (this.session.answers.length > 0) this._finishQuiz(); else this.showScreen('exam');
  }

  // ── Results ────────────────────────────────────────
  _finishQuiz() {
    clearInterval(this.timerInterval);
    const results = this.session.getResults();
    this.lastResults = results;
    this.storage.recordSession(this.currentUser.id, this.exam.meta.id, results);
    this._renderResults(results);
    this.showScreen('result');
  }

  _renderResults(results) {
    const { score, correct, total, categories, wrongAnswers } = results;

    document.getElementById('result-score').textContent = `${score}%`;
    document.getElementById('result-detail').textContent = `${correct} / ${total} 問正解`;

    const passEl = document.getElementById('pass-badge');
    passEl.textContent = score >= 70 ? '合格ライン達成！' : '合格ラインまで頑張ろう';
    passEl.className = `pass-badge ${score >= 70 ? 'pass' : 'fail'}`;

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
    const choiceLabels = ['A', 'B', 'C', 'D'];
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

  _retryMode() { this._startMode(this.session.mode); }

  _reviewWrongs() {
    if (!this.lastResults || this.lastResults.wrongAnswers.length === 0) return;
    const wrongIds = new Set(this.lastResults.wrongAnswers.map(a => String(a.questionId)));
    const originalQuestions = this.exam.questions.filter(q => wrongIds.has(String(q.id)));
    const questions = this._shuffle(originalQuestions).map(q => this._shuffleChoices(q));
    this.session = new QuizSession({ questions, mode: 'study', examId: this.exam.meta.id });
    this._startQuiz();
  }

  // ── Stats Screen ───────────────────────────────────
  _showStats() {
    if (!this.exam || !this.currentUser) return;
    const uid = this.currentUser.id;
    const stats = this.storage.getExamStats(uid, this.exam.meta.id);

    document.getElementById('stats-exam-name').textContent = this.exam.meta.name;

    const list = document.getElementById('q-stats-list');
    list.innerHTML = '';
    for (const q of this.exam.questions) {
      const s = stats.questions[String(q.id)];
      const total = s ? s.total : 0;
      const correct = s ? s.correct : 0;
      const pct = total > 0 ? Math.round((correct / total) * 100) : null;
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

    const sessions = stats.sessions || [];
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

  _resetStats() {
    if (!this.exam || !this.currentUser) return;
    if (!confirm('この試験の学習データをすべてリセットしますか？')) return;
    this.storage.clearExamStats(this.currentUser.id, this.exam.meta.id);
    this._toast('学習データをリセットしました');
    this._renderExamCard();
    this._showStats();
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
