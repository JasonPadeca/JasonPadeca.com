/* =========================================================
   Deslop — order form
   NOTE: every figure computed here is for DISPLAY ONLY.
   The server recounts words from the stored text and derives
   the charge from its own rate table before creating the
   Stripe session. Nothing on this page is trusted. See the
   threat model, item 01.
   ========================================================= */

(function () {
  'use strict';

  var RATE      = 0.50;   // $ per word, standard
  var RUSH_RATE = 1.00;   // $ per word, rush
  var MIN_WORDS = 50;     // shorter jobs are billed as 50 words
  var WORD_CAP  = 8000;   // paste limit; above this, upload a file
  var FILE_MAX  = 10 * 1024 * 1024;
  var SAMPLE_CAP = 400;   // words we'll look at for a free sample

  var $ = function (id) { return document.getElementById(id); };

  var text     = $('text');
  var file     = $('file');
  var email    = $('email');
  var rush     = $('rush');
  var sample   = $('sample');
  var wordsOut = $('words');
  var costOut  = $('cost');
  var counter  = $('counter');
  var capHint  = $('cap-hint');
  var submit   = $('submit');
  var note     = $('submit-note');
  var form     = $('order-form');

  var money0 = new Intl.NumberFormat('en-US', {
    style: 'currency', currency: 'USD',
    minimumFractionDigits: 0, maximumFractionDigits: 0
  });
  var money2 = new Intl.NumberFormat('en-US', {
    style: 'currency', currency: 'USD',
    minimumFractionDigits: 2, maximumFractionDigits: 2
  });

  // whole dollars read as $500, anything with cents as $1.50
  function money(n) {
    n = Math.round(n * 100) / 100;
    return (n % 1 === 0) ? money0.format(n) : money2.format(n);
  }

  function countWords(s) {
    var t = String(s || '').trim();
    if (!t) return 0;
    return t.split(/\s+/).length;
  }

  function priceFor(words, isRush) {
    return Math.max(words, MIN_WORDS) * (isRush ? RUSH_RATE : RATE);
  }

  function update() {
    var words = countWords(text.value);
    var isSample = sample.checked;
    var over = words > WORD_CAP;

    wordsOut.textContent = words.toLocaleString('en-US');
    counter.classList.toggle('over', over && !isSample);

    // rush is meaningless on a free sample
    rush.disabled = isSample;
    if (isSample) rush.checked = false;

    if (isSample) {
      costOut.textContent = 'free sample';
      capHint.textContent = words > SAMPLE_CAP
        ? 'We’ll rewrite the first ' + SAMPLE_CAP + ' words or so — send the rest when you’re ready to order.'
        : 'Send as much or as little as you like.';
      capHint.className = 'hint';
      submit.textContent = 'Request free sample';
      note.textContent = 'No card needed. A writer reads every sample request, so give us a day or two.';
    } else if (words === 0) {
      costOut.textContent = '—';
      capHint.textContent = 'Over 8,000 words? Upload a file instead.';
      capHint.className = 'hint';
      submit.textContent = 'Continue to payment';
      note.textContent = 'You’ll see a confirmation page with the final word count and price before anything is charged.';
    } else if (over) {
      costOut.textContent = money(priceFor(words, rush.checked));
      capHint.textContent = 'That’s over the 8,000-word paste limit. Upload it as a file below and we’ll take it from there.';
      capHint.className = 'hint warn';
      submit.textContent = 'Continue to payment';
      note.textContent = 'You’ll see a confirmation page with the final word count and price before anything is charged.';
    } else {
      var p = priceFor(words, rush.checked);
      costOut.textContent = money(p);
      capHint.textContent = (words < MIN_WORDS)
        ? MIN_WORDS + '-word minimum \u2014 shorter jobs are billed as ' + MIN_WORDS + ' words.'
        : (rush.checked
            ? 'Rush rate. Straight to the front of the queue.'
            : 'Standard rate. Most work comes back the same day.');
      capHint.className = 'hint';
      submit.textContent = 'Continue to payment — ' + money(p);
      note.textContent = 'You’ll see a confirmation page with the final word count and price before anything is charged.';
    }

    var hasContent = words > 0 || (file.files && file.files.length > 0);
    submit.disabled = !hasContent;
  }

  function validEmail(v) {
    return /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(String(v || '').trim());
  }

  ['input', 'change'].forEach(function (ev) {
    text.addEventListener(ev, update);
    file.addEventListener(ev, update);
  });
  rush.addEventListener('change', update);
  sample.addEventListener('change', update);

  file.addEventListener('change', function () {
    var f = file.files && file.files[0];
    if (f && f.size > FILE_MAX) {
      file.value = '';
      window.alert('That file is ' + (f.size / 1048576).toFixed(1) + ' MB. The limit is 10 MB — send it as .docx or .txt if you can, PDFs are usually the culprit.');
    }
    update();
  });

  form.addEventListener('submit', function (e) {
    e.preventDefault();

    if (!validEmail(email.value)) {
      email.focus();
      window.alert('We need an email address to send the rewrite to.');
      return;
    }

    var words = countWords(text.value);
    var hasFile = file.files && file.files.length > 0;
    if (!words && !hasFile) {
      text.focus();
      return;
    }

    var cfg = window.LACQUER_CONFIG || {};
    if (!cfg.FUNCTIONS_URL || !cfg.SUPABASE_ANON_KEY) {
      window.alert('The order system isn\u2019t connected yet. Nothing was sent.');
      return;
    }

    if (hasFile && !words) {
      window.alert('File upload isn\u2019t wired up yet \u2014 paste the text in for now.');
      return;
    }

    var restore = submit.textContent;
    submit.disabled = true;
    submit.textContent = 'Sending\u2026';

    fetch(cfg.FUNCTIONS_URL + '/create-order', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': 'Bearer ' + cfg.SUPABASE_ANON_KEY
      },
      body: JSON.stringify({
        email: email.value.trim(),
        text: text.value,
        rush: rush.checked,
        sample: sample.checked
      })
    })
      .then(function (res) {
        return res.json().then(function (data) {
          if (!res.ok) throw new Error(data.error || 'Something went wrong.');
          return data;
        });
      })
      .then(function (out) {
        // The server recounted and repriced; the confirmation page shows its
        // figures, not ours.
        window.location.href = 'confirm.html?order=' + encodeURIComponent(out.token);
      })
      .catch(function (err) {
        submit.disabled = false;
        submit.textContent = restore;
        window.alert(err.message || 'Could not reach the order system. Try again in a moment.');
      });
  });

  update();
})();
