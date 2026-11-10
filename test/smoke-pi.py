"""Isolated real-Pi PTY smoke; only localhost mock APIs and synthetic credentials."""
import codecs
import fcntl
import json
import os
from pathlib import Path
import pty
import select
import shutil
import signal
import struct
import subprocess
import tempfile
import termios
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

# Test-only dependency: pip install pyte
import pyte

ROOT = Path(__file__).resolve().parents[1]
(ROOT / '.scratch').mkdir(exist_ok=True)
requests = []
coach_delay = 1.5
first_prompt = '先不实现，只分析计划。 /Users/synthetic/PRIVATE_PATH.ts https://example.com/PRIVATE_LINK'


class Handler(BaseHTTPRequestHandler):
    def log_message(self, *args):
        pass

    def do_POST(self):
        body = json.loads(self.rfile.read(int(self.headers['Content-Length'])))
        self.path = self.path.split('?', 1)[0]
        requests.append({'path': self.path, 'body': body, 'time': time.monotonic(),
                         'key': self.headers.get('x-api-key')})
        if self.path == '/coach/v1/messages':
            assert self.headers.get('x-api-key') == 'synthetic-coach-key'
            time.sleep(coach_delay)
            lesson = {'english': "LEARNING_ONLY_42 Don't implement anything yet.",
                      'grammar': {'excerpt': "Don't implement", 'pattern': "先不做用 don't",
                                  'explanation': '否定祈使句，表示暂时不要执行。'}}
            text = json.dumps(lesson)
            data = json.dumps({'type': 'message', 'stop_reason': 'end_turn',
                               'content': [{'type': 'text', 'text': text}]}).encode()
            self.send_response(200)
            self.send_header('Content-Type', 'application/json')
            self.send_header('Content-Length', str(len(data)))
            self.end_headers()
            try:
                self.wfile.write(data)
            except (BrokenPipeError, ConnectionResetError):
                pass
            return
        assert self.path == '/main/v1/messages', self.path
        # Reproduce Orca's exact trigger: automatic practice opens during a main turn.
        if len([r for r in requests if r['path'] == '/main/v1/messages']) == 1:
            time.sleep(3)
        self.send_response(200)
        self.send_header('Content-Type', 'text/event-stream')
        self.end_headers()
        events = [
            ('message_start', {'type': 'message_start', 'message': {'id': 'main-smoke', 'type': 'message',
                'role': 'assistant', 'model': 'smoke-main', 'content': [], 'stop_reason': None,
                'usage': {'input_tokens': 12, 'output_tokens': 0}}}),
            ('content_block_start', {'type': 'content_block_start', 'index': 0,
                                     'content_block': {'type': 'text', 'text': ''}}),
            ('content_block_delta', {'type': 'content_block_delta', 'index': 0,
                                     'delta': {'type': 'text_delta', 'text': 'MAIN_ONLY_42'}}),
            ('content_block_stop', {'type': 'content_block_stop', 'index': 0}),
            ('message_delta', {'type': 'message_delta', 'delta': {'stop_reason': 'end_turn', 'stop_sequence': None},
                               'usage': {'output_tokens': 5}}),
            ('message_stop', {'type': 'message_stop'}),
        ]
        try:
            for event, data in events:
                self.wfile.write(f'event: {event}\ndata: {json.dumps(data)}\n\n'.encode())
            self.wfile.flush()
        except (BrokenPipeError, ConnectionResetError):
            # A failed in-flight regression assertion may terminate Pi before this response.
            pass


server = ThreadingHTTPServer(('127.0.0.1', 0), Handler)
threading.Thread(target=server.serve_forever, daemon=True).start()
base = f'http://127.0.0.1:{server.server_port}'
master, slave = pty.openpty()
fcntl.ioctl(slave, termios.TIOCSWINSZ, struct.pack('HHHH', 40, 100, 0, 0))
screen = pyte.Screen(100, 40)
stream = pyte.Stream(screen)
decoder = codecs.getincrementaldecoder('utf-8')('replace')
raw = bytearray()


def pump(timeout=0.05):
    if select.select([master], [], [], timeout)[0]:
        try:
            data = os.read(master, 65536)
        except OSError:
            return
        raw.extend(data)
        stream.feed(decoder.decode(data))


def wait_for(predicate, description, timeout=20):
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        pump()
        if predicate():
            return
        if proc.poll() is not None:
            raise AssertionError(f'Pi exited ({proc.returncode}): {bytes(raw).decode(errors="replace")}')
    raise AssertionError(f'Timed out: {description}\n' + '\n'.join(screen.display))


def submit(text):
    os.write(master, ('\x1b[200~' + text + '\x1b[201~').encode())
    # Let the bracketed paste arrive before Enter.
    for _ in range(3):
        pump()
    os.write(master, b'\r')


def visible(text):
    return any(text in line for line in screen.display)


with tempfile.TemporaryDirectory(prefix='language-coach-pi-smoke-') as tmp:
    home = Path(tmp)
    agent = home / '.pi' / 'agent'
    agent.mkdir(parents=True)
    (agent / 'models.json').write_text(json.dumps({'providers': {'smoke-main': {
        'baseUrl': base + '/main', 'api': 'anthropic-messages', 'apiKey': 'synthetic-main-key',
        'models': [{'id': 'smoke-main', 'name': 'Local smoke main', 'reasoning': False,
                    'input': ['text'], 'contextWindow': 32000, 'maxTokens': 1024}]}}}))
    session = home / 'conversation.jsonl'
    prompt_log = home / 'ui-prompts.jsonl'
    turn_status = home / 'turn-status.txt'
    control_answer = home / 'control-answer.txt'
    observer = home / 'prompt-observer.ts'
    # Observe the host's real events, not OSC 7501 or coach implementation details.
    # Deliberately retain only event metadata, never prompts, typed input or keys.
    observer.write_text('''import { appendFileSync, writeFileSync } from 'node:fs';
export default function (pi) {
  let inFlight = false;
  pi.on('agent_start', () => {
    inFlight = true;
    writeFileSync(process.env.SMOKE_TURN_STATUS, 'in-flight');
  });
  pi.on('agent_end', () => {
    inFlight = false;
    writeFileSync(process.env.SMOKE_TURN_STATUS, 'settled');
  });
  for (const type of ['ui_prompt_start', 'ui_prompt_end']) {
    pi.on(type, event => {
      appendFileSync(process.env.SMOKE_PROMPT_LOG,
        JSON.stringify({ type: event.type, kind: event.kind, inFlight }) + '\\n');
    });
  }
  pi.registerCommand('smoke-question', {
    description: 'Isolated prompt-event positive control',
    handler: async (_args, ctx) => {
      const answer = await ctx.ui.confirm('Control question', 'Allow?');
      writeFileSync(process.env.SMOKE_CONTROL_ANSWER, answer ? 'yes' : 'no');
    },
  });
}
''')

    def prompt_events():
        return [json.loads(line) for line in prompt_log.read_text().splitlines()] if prompt_log.exists() else []

    def assert_no_practice_prompts(stage):
        assert prompt_events() == [], f'{stage} emitted blocking UI prompt events: {prompt_events()}'

    saved_directory = agent / 'language-coach' / 'saved'
    browser_bin = home / 'browser-bin'
    browser_bin.mkdir()
    browser_log = home / 'opened-url.txt'
    # Replace the OS opener only in this isolated child process; no user browser tabs.
    for launcher in ('open', 'xdg-open'):
        stub = browser_bin / launcher
        stub.write_text('#!/bin/sh\nprintf "%s" "$1" > "$COACH_BROWSER_LOG"\n')
        stub.chmod(0o700)
    if os.environ.get('COACH_SMOKE_FULLSCREEN') == '1':
        (agent / 'settings.json').write_text(json.dumps({'tuiMode': 'fullscreen'}))
    env = {'PATH': str(browser_bin) + os.pathsep + os.environ['PATH'], 'HOME': tmp, 'TERM': 'xterm-256color', 'COLORTERM': 'truecolor',
           'COACH_BROWSER_LOG': str(browser_log),
           'SMOKE_PROMPT_LOG': str(prompt_log), 'SMOKE_TURN_STATUS': str(turn_status),
           'SMOKE_CONTROL_ANSWER': str(control_answer),
           'PI_CODING_AGENT_DIR': str(agent), 'PI_OFFLINE': '1', 'PI_TELEMETRY': '0',
           'PI_LANGUAGE_COACH_API_KEY': 'synthetic-coach-key',
           'PI_LANGUAGE_COACH_AUTO_SAVE': 'false',
           'PI_LANGUAGE_COACH_BASE_URL': base + '/coach', 'PI_LANGUAGE_COACH_MODEL': 'smoke-coach'}
    proc = subprocess.Popen([shutil.which('pi'), '--no-extensions', '--no-skills', '--no-mcp',
        '--no-context-files', '--no-prompt-templates', '--no-themes', '--offline', '--approve',
        '--no-tools', '--session', str(session), '--model', 'smoke-main/smoke-main',
        '-e', str(ROOT / 'src' / 'index.ts'), '-e', str(observer)], env=env, cwd=tmp,
        stdin=slave, stdout=slave, stderr=slave, start_new_session=True)
    os.close(slave)
    try:
        wait_for(lambda: visible('Local smoke main') or visible('smoke-main'), 'startup')
        submit(first_prompt)
        wait_for(lambda: any(r['path'] == '/main/v1/messages' for r in requests), 'main request')
        main_time = next(r['time'] for r in requests if r['path'] == '/main/v1/messages')
        coach_time = next(r['time'] for r in requests if r['path'] == '/coach/v1/messages')
        assert main_time - coach_time < 1.2, 'Main request blocked on coaching'
        wait_for(lambda: visible('LEARNING_ONLY_42') and visible('语法'), 'two-row lesson')
        wait_for(lambda: visible('输入一遍') and visible('回车结束'), 'native practice editor appears with borders')
        assert turn_status.read_text() == 'in-flight', 'First practice must open while main turn is in flight'
        assert_no_practice_prompts('Automatic practice during main turn')
        practice_lines = list(screen.display)
        top = next(i for i, line in enumerate(practice_lines) if '输入一遍' in line)
        assert '─' in practice_lines[top] and '回车结束' in practice_lines[top + 2], '\n'.join(practice_lines)
        (ROOT / '.scratch' / 'smoke-practice-editor.txt').write_text('\n'.join(practice_lines))
        os.write(master, b'\x1b')  # Esc: leave the row; the two rows stay untouched.
        wait_for(lambda: not visible('输入一遍'), 'typing row closed')
        assert_no_practice_prompts('Esc closes automatic practice')
        wait_for(lambda: turn_status.read_text() == 'settled' and visible('MAIN_ONLY_42'), 'first main turn settles')
        lines = screen.display
        english_index = next(i for i, line in enumerate(lines) if 'LEARNING_ONLY_42' in line)
        assert '语法' in lines[english_index + 1], '\n'.join(lines)
        assert 'MAIN_ONLY_42' in bytes(raw).decode(errors='replace')
        assert not lines[english_index].strip().startswith('EN ')
        assert not saved_directory.exists(), 'Must not store automatically'
        # Exercise the real F8 binding with an unsent editor draft present.
        os.write(master, b'\x1b[200~DRAFT_ONLY_42\x1b[201~')
        for _ in range(4):
            pump()
        os.write(master, b'\x1b[19~')
        wait_for(lambda: saved_directory.exists() and len(list(saved_directory.glob('*.json'))) == 1
                 and visible('已收藏'), 'shortcut writes and confirms save')
        saved_file = next(saved_directory.glob('*.json'))
        saved_record = json.loads(saved_file.read_text())
        assert saved_record['original'] == first_prompt
        assert saved_record['english'] == "LEARNING_ONLY_42 Don't implement anything yet."
        assert saved_record['grammar']['excerpt'] == "Don't implement"
        assert saved_record['grammar']['pattern'] == "先不做用 don't"
        assert saved_record['grammar']['explanation'] == '否定祈使句，表示暂时不要执行。'
        assert 'DRAFT_ONLY_42' not in saved_file.read_text()
        assert visible('DRAFT_ONLY_42'), 'Shortcut changed editor draft'
        assert len(requests) == 2, 'Saving must not request any model'
        before = saved_file.read_text()
        os.write(master, b'\x1b[19~')
        wait_for(lambda: visible('已收藏过'), 'duplicate shortcut save')
        assert saved_file.read_text() == before
        assert len(list(saved_directory.glob('*.json'))) == 1
        wait_for(lambda: not visible('已收藏'), 'temporary notice disappears')
        assert visible('语法'), 'Grammar was not restored after notice'
        os.write(master, b'\x15')  # Remove unsent draft before continuing.
        for _ in range(4):
            pump()
        (ROOT / '.scratch' / 'smoke-wide.txt').write_text('\n'.join(lines))
        # Resize: long English wraps onto more rows, notes follow the English.
        fcntl.ioctl(master, termios.TIOCSWINSZ, struct.pack('HHHH', 40, 36, 0, 0))
        screen.resize(40, 36)
        os.kill(proc.pid, signal.SIGWINCH)
        wait_for(lambda: visible('LEARNING_ONLY_42') and visible('语法'), 'narrow repaint')
        for _ in range(8):
            pump()
        (ROOT / '.scratch' / 'smoke-narrow.txt').write_text('\n'.join(screen.display))
        english_index = next(i for i, line in enumerate(screen.display) if 'LEARNING_ONLY_42' in line)
        grammar_index = next(i for i, line in enumerate(screen.display) if '语法' in line)
        assert grammar_index > english_index, 'notes come after the English'
        assert all(len(line.rstrip()) <= 36 for line in screen.display[english_index:grammar_index + 1])
        assert visible('nything yet.'), 'the translated tail wraps into view without paging'
        # Main context receives no teaching results, even on the next actual turn.
        submit('第二条提示，只检查。')
        wait_for(lambda: len([r for r in requests if r['path'] == '/main/v1/messages']) == 2, 'second main request')
        wait_for(lambda: visible('LEARNING_ONLY_42'), 'second lesson')
        # The typing row opens by default again, next to the untouched two rows.
        wait_for(lambda: visible('输入一遍'), 'typing row appears by default with the second result')
        assert_no_practice_prompts('Second automatic practice')
        typing_screen = list(screen.display)
        assert any('LEARNING_ONLY_42' in line for line in typing_screen), 'English stays visible while typing'
        assert any('语法' in line for line in typing_screen), 'Grammar stays visible while typing'
        assert len([r for r in requests if r['path'] == '/coach/v1/messages']) == 2, 'The row itself requests nothing'
        os.write(master, b"LEARNING_ONLY_42 Don't implement anything yet.")
        for _ in range(3):
            pump()
        assert not visible('照着第一行敲一遍'), 'The placeholder yields to the typed lap'
        os.write(master, b'\r')  # Enter closes the row; no model, no notice.
        wait_for(lambda: not visible('输入一遍'), 'Enter closes the typing row')
        assert_no_practice_prompts('Enter closes automatic practice')
        assert len([r for r in requests if r['path'] == '/coach/v1/messages']) == 2, 'Typing must not request any model'
        assert len(list(saved_directory.glob('*.json'))) == 1, 'Typing stores nothing'
        # No practice shortcut exists: the command can only run on a clean editor
        # line, so a draft must be cleared before reopening. Draft preservation
        # across open/close stays covered by the practice unit tests.
        os.write(master, b'NEXT_DRAFT_42')
        for _ in range(4):
            pump()
        wait_for(lambda: visible('NEXT_DRAFT_42'), 'draft entered into the idle editor')
        os.write(master, b'\x15')  # Ctrl+U clears the draft so the command line is clean.
        for _ in range(4):
            pump()
        assert not visible('NEXT_DRAFT_42'), 'Ctrl+U cleared the draft'
        submit('/coach practice')  # The command reopens the row; no model request.
        wait_for(lambda: visible('输入一遍'), 'typing row reopens via /coach practice')
        assert_no_practice_prompts('/coach practice reopens practice')
        os.write(master, b'PRACTICE_LAP_42')  # Typed inside the reopened row.
        for _ in range(4):
            pump()
        wait_for(lambda: visible('PRACTICE_LAP_42'), 'lap typed into the reopened row')
        os.write(master, b'\x1b')  # Esc closes; the lap never lands in the main editor.
        wait_for(lambda: not visible('输入一遍'), 'typing row closed again')
        wait_for(lambda: not visible('PRACTICE_LAP_42'), 'practice lap never lands in the main editor')
        assert_no_practice_prompts('Esc closes reopened practice')
        os.write(master, b'\x15')  # Remove any editor residue before continuing.
        for _ in range(4):
            pump()
        wait_for(lambda: visible('语法'), 'panel unchanged after leaving')
        submit('/coach save')
        wait_for(lambda: len(list(saved_directory.glob('*.json'))) == 2, 'fallback save command')
        assert len(requests) == 4, 'Save command must not request any model'
        submit('/coach review')
        wait_for(lambda: browser_log.exists() and (saved_directory / 'review.html').exists(), 'review opens snapshot')
        from urllib.parse import urlparse, unquote
        review_url = browser_log.read_text()
        assert urlparse(review_url).scheme == 'file'
        assert Path(unquote(urlparse(review_url).path)) == saved_directory / 'review.html'
        review_html = (saved_directory / 'review.html').read_text()
        assert review_html.count('<article class="lesson">') == 2
        assert '先不实现，只分析计划。' in review_html
        assert '第二条提示，只检查。' in review_html
        assert 'LEARNING_ONLY_42' in review_html
        assert '否定祈使句' in review_html
        assert '<script' not in review_html and '示例数据' not in review_html
        assert len(requests) == 4, 'Review command must not request any model'
        assert 'learning_only_42' not in session.read_text().lower(), 'Review must not enter main session'
        for req in [r for r in requests if r['path'] == '/main/v1/messages']:
            text = json.dumps(req['body'], ensure_ascii=False)
            assert 'learning_only_42' not in text.lower()
            assert '否定祈使句' not in text
            assert 'you are an english language coach' not in text.lower()
            assert first_prompt in text, 'Main input must retain paths and links'
        coaches = [r for r in requests if r['path'] == '/coach/v1/messages']
        assert len(coaches) == 2
        assert coaches[0]['body']['messages'][0]['content'] == '先不实现，只分析计划。 「文件」 「链接」'
        assert 'PRIVATE_PATH' not in json.dumps(coaches[0]['body'])
        assert 'PRIVATE_LINK' not in json.dumps(coaches[0]['body'])
        assert len(coaches[1]['body']['messages']) == 1
        assert '第二条提示，只检查。' in json.dumps(coaches[1]['body'], ensure_ascii=False)
        assert '先不实现' not in json.dumps(coaches[1]['body'], ensure_ascii=False)
        assert 'MAIN_ONLY_42' not in json.dumps(coaches[1]['body'])
        assert 'learning_only_42' not in session.read_text().lower()
        assert 'wrong_attempt_42' not in session.read_text().lower(), 'Typed laps never enter the main session'
        assert 'you are an english language coach' not in session.read_text().lower()
        assert '已收藏' not in session.read_text()
        assert 'savedAt' not in session.read_text()
        # Positive control: real blocking prompts still work and emit both host events.
        wait_for(lambda: turn_status.read_text() == 'settled', 'main settled before control')
        assert_no_practice_prompts('All practice interactions before control')
        before_control = len(requests)
        submit('/smoke-question')
        wait_for(lambda: visible('Control question') and visible('Allow?') and len(prompt_events()) == 1,
                 'real confirmation opens and emits start')
        assert prompt_events() == [{'type': 'ui_prompt_start', 'kind': 'confirm', 'inFlight': False}]
        os.write(master, b'\r')  # Native confirmation defaults to Yes; Enter accepts it.
        wait_for(lambda: control_answer.exists() and len(prompt_events()) == 2,
                 'confirmation answered and emits end')
        assert control_answer.read_text() == 'yes', 'Positive control must actually accept the confirmation'
        control_events = [{'type': event, 'kind': 'confirm', 'inFlight': False}
                          for event in ('ui_prompt_start', 'ui_prompt_end')]
        assert prompt_events() == control_events, prompt_events()
        assert len(requests) == before_control, 'Confirmation must not submit to any model'
        assert 'smoke-question' not in session.read_text(), 'Control command must not enter main context'
        # Clearing cancels in-flight request and prevents it repainting.
        submit('/coach clear')
        wait_for(lambda: not visible('LEARNING_ONLY_42'), 'clear lesson')
        until = time.monotonic() + 2
        while time.monotonic() < until:
            pump()
        assert not visible('LEARNING_ONLY_42'), 'Cancelled completion repainted widget'
        os.write(master, b'\x1b[19~')
        for _ in range(5):
            pump()
        assert len(list(saved_directory.glob('*.json'))) == 2, 'No hidden/stale lesson may be saved'
        submit('/coach off')
        submit('关闭学习后仍正常提问。')
        wait_for(lambda: len([r for r in requests if r['path'] == '/main/v1/messages']) == 3, 'main while off')
        assert len([r for r in requests if r['path'] == '/coach/v1/messages']) == 2
        assert 'learning_only_42' not in session.read_text().lower()
        submit('/coach on')
        submit('/coach autosave on')
        submit('自动收藏真实验证。')
        wait_for(lambda: len(list(saved_directory.glob('*.json'))) == 3,
                 'automatic save on completed new lesson')
        assert any(json.loads(file.read_text())['original'] == '自动收藏真实验证。'
                   for file in saved_directory.glob('*.json'))
        assert len([r for r in requests if r['path'] == '/coach/v1/messages']) == 3
        assert len([r for r in requests if r['path'] == '/main/v1/messages']) == 4
        assert 'learning_only_42' not in session.read_text().lower()
        assert prompt_events() == control_events, 'Only the positive-control confirmation may emit prompt events'
        print(json.dumps({'passed': True, 'main_requests': 4, 'coach_requests': 3,
            'ui_prompt_events': prompt_events(),
            'main_wait_seconds': round(main_time - coach_time, 3), 'terminal_widths': [100, 36],
            'checks': ['real Pi load', 'English and notes rows adjacent', 'resize', 'nonblocking input',
                       'independent key', 'main payload isolation', 'learning history isolation',
                       'no session persistence', 'clear cancels', 'off stops requests',
                       'real F8 save', 'full content persistence', 'duplicate deduplication',
                       'editor draft preserved', 'temporary two-row feedback',
                       'review opens offline HTML with real saved lessons and no model request',
                       'narrow terminal wraps the full English', 'autosave off keeps manual save',
                       'autosave on writes only completed lesson',
                       'automatic practice while main in flight emits no UI prompt events',
                       '/coach practice reopen and Enter/Esc close emit no UI prompt events',
                       'ordinary confirm emits start/end without main submission',
                       'mixed-case mock English and embedded grammar normalize to lowercase',
                       'case-insensitive learning sentinel isolation']}, ensure_ascii=False))
    finally:
        proc.terminate()
        try:
            proc.wait(timeout=5)
        except subprocess.TimeoutExpired:
            proc.kill()
            proc.wait()
        os.close(master)
        server.shutdown()
