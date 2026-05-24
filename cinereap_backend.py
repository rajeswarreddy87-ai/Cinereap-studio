#!/usr/bin/env python3
"""
CineRecap Studio — Termux Backend
===================================
Run this on your Android phone via Termux.
It handles FFMPEG video clipping, rendering,
and ElevenLabs voiceover generation locally.

SETUP (run once in Termux):
  pkg update && pkg upgrade -y
  pkg install python ffmpeg -y
  pip install flask flask-cors requests

RUN:
  python cinereap_backend.py

Then in the app settings, set Backend URL to:
  http://localhost:5000
"""

from flask import Flask, request, jsonify, send_file
from flask_cors import CORS
import subprocess, os, json, requests, threading, uuid, time

app = Flask(__name__)
CORS(app)  # Allow requests from GitHub Pages

# ── Directories ──────────────────────────
BASE_DIR = os.path.expanduser('~/cinereap')
UPLOAD_DIR = os.path.join(BASE_DIR, 'uploads')
CLIPS_DIR  = os.path.join(BASE_DIR, 'clips')
OUTPUT_DIR = os.path.join(BASE_DIR, 'output')
AUDIO_DIR  = os.path.join(BASE_DIR, 'audio')

for d in [UPLOAD_DIR, CLIPS_DIR, OUTPUT_DIR, AUDIO_DIR]:
    os.makedirs(d, exist_ok=True)

# ── Job tracking ─────────────────────────
jobs = {}

def new_job(name):
    jid = str(uuid.uuid4())[:8]
    jobs[jid] = {'id': jid, 'name': name, 'status': 'running', 'progress': 0, 'log': [], 'result': None}
    return jid

def log(jid, msg):
    jobs[jid]['log'].append(f'[{time.strftime("%H:%M:%S")}] {msg}')
    print(msg)

def finish(jid, result=None, error=None):
    jobs[jid]['status'] = 'done' if not error else 'error'
    jobs[jid]['progress'] = 100
    jobs[jid]['result'] = result
    if error: jobs[jid]['error'] = error

# ══════════════════════════════════════════
#  ROUTES
# ══════════════════════════════════════════

@app.route('/ping')
def ping():
    """Health check — app uses this to detect backend"""
    return jsonify({'status': 'ok', 'version': '1.0', 'message': 'CineRecap Backend running on your Android!'})


# ── ANTHROPIC PROXY ───────────────────────
@app.route('/anthropic', methods=['POST'])
def anthropic_proxy():
    data    = request.json
    api_key = data.get('api_key', '')
    prompt  = data.get('prompt', '')
    model   = data.get('model', 'claude-sonnet-4-20250514')
    max_tok = data.get('max_tokens', 1000)
    if not api_key:
        return jsonify({'error': 'No API key'}), 400
    try:
        r = requests.post(
            'https://api.anthropic.com/v1/messages',
            headers={'x-api-key': api_key, 'anthropic-version': '2023-06-01', 'Content-Type': 'application/json'},
            json={'model': model, 'max_tokens': max_tok, 'messages': [{'role': 'user', 'content': prompt}]},
            timeout=60
        )
        return jsonify(r.json()), r.status_code
    except Exception as e:
        return jsonify({'error': str(e)}), 500

# ── ELEVENLABS PROXY ──────────────────────
@app.route('/elevenlabs', methods=['POST'])
def elevenlabs_proxy():
    data       = request.json
    api_key    = data.get('api_key', '')
    text       = data.get('text', '')
    voice_id   = data.get('voice_id', 'pNInz6obpgDQGcFmaJgB')
    stability  = data.get('stability', 0.6)
    similarity = data.get('similarity', 0.75)
    if not api_key:
        return jsonify({'error': 'No API key'}), 400
    try:
        r = requests.post(
            f'https://api.elevenlabs.io/v1/text-to-speech/{voice_id}',
            headers={'xi-api-key': api_key, 'Content-Type': 'application/json', 'Accept': 'audio/mpeg'},
            json={'text': text, 'model_id': 'eleven_monolingual_v1', 'voice_settings': {'stability': stability, 'similarity_boost': similarity}},
            timeout=120
        )
        if r.status_code == 200:
            audio_path = os.path.join(AUDIO_DIR, 'voiceover.mp3')
            with open(audio_path, 'wb') as f:
                f.write(r.content)
            dur = subprocess.run(['ffprobe', '-v', 'quiet', '-show_entries', 'format=duration', '-of', 'csv=p=0', audio_path], capture_output=True, text=True)
            duration = float(dur.stdout.strip() or 0)
            size_mb  = round(os.path.getsize(audio_path) / 1e6, 1)
            return jsonify({'status': 'ok', 'audio_path': audio_path, 'duration': duration, 'duration_fmt': f'{int(duration//60):02d}:{int(duration%60):02d}', 'size_mb': size_mb})
        else:
            return jsonify({'error': f'ElevenLabs error {r.status_code}: {r.text[:200]}'}), r.status_code
    except Exception as e:
        return jsonify({'error': str(e)}), 500

@app.route('/job/<jid>')
def job_status(jid):
    """Poll job progress"""
    return jsonify(jobs.get(jid, {'status': 'not_found'}))

# ── UPLOAD MOVIE ──────────────────────────
@app.route('/upload', methods=['POST'])
def upload_movie():
    if 'file' not in request.files:
        return jsonify({'error': 'No file'}), 400
    f = request.files['file']
    filename = f'movie_{uuid.uuid4().hex[:8]}{os.path.splitext(f.filename)[1]}'
    path = os.path.join(UPLOAD_DIR, filename)
    f.save(path)

    # Get video info
    result = subprocess.run([
        'ffprobe', '-v', 'quiet', '-print_format', 'json',
        '-show_format', '-show_streams', path
    ], capture_output=True, text=True)

    info = json.loads(result.stdout) if result.returncode == 0 else {}
    duration = float(info.get('format', {}).get('duration', 0))

    return jsonify({
        'filename': filename,
        'path': path,
        'duration': duration,
        'duration_fmt': f'{int(duration//3600):02d}:{int((duration%3600)//60):02d}:{int(duration%60):02d}',
        'size_mb': round(os.path.getsize(path) / 1e6, 1)
    })

# ── CLIP EXTRACTION ───────────────────────
@app.route('/clip', methods=['POST'])
def extract_clips():
    data = request.json
    movie_path = data.get('movie_path')
    timestamps  = data.get('timestamps', [])
    mode        = data.get('mode', 'fast')  # fast | precise | cinematic

    if not movie_path or not os.path.exists(movie_path):
        return jsonify({'error': 'Movie file not found'}), 400

    jid = new_job('clip_extraction')

    def run():
        clips = []
        total = len(timestamps)
        log(jid, f'Starting extraction of {total} clips...')

        for i, ts in enumerate(timestamps):
            clip_name = f'clip_{str(i+1).zfill(2)}.mp4'
            clip_path = os.path.join(CLIPS_DIR, clip_name)

            jobs[jid]['progress'] = int((i / total) * 85)
            log(jid, f'Extracting clip {i+1}/{total}: {ts["start"]} → {ts["end"]}')

            if mode == 'fast':
                # Stream copy — fastest, no re-encode
                cmd = [
                    'ffmpeg', '-y',
                    '-ss', ts['start'],
                    '-to', ts['end'],
                    '-i', movie_path,
                    '-c', 'copy',
                    clip_path
                ]
            elif mode == 'precise':
                # Re-encode for frame accuracy
                cmd = [
                    'ffmpeg', '-y',
                    '-i', movie_path,
                    '-ss', ts['start'],
                    '-to', ts['end'],
                    '-c:v', 'libx264', '-preset', 'fast',
                    '-c:a', 'aac',
                    clip_path
                ]
            else:  # cinematic
                cmd = [
                    'ffmpeg', '-y',
                    '-ss', ts['start'],
                    '-to', ts['end'],
                    '-i', movie_path,
                    '-vf', 'scale=1920:1080:force_original_aspect_ratio=decrease,pad=1920:1080:(ow-iw)/2:(oh-ih)/2,vignette',
                    '-c:v', 'libx264', '-preset', 'fast', '-crf', '20',
                    '-c:a', 'aac',
                    clip_path
                ]

            result = subprocess.run(cmd, capture_output=True, text=True)

            if result.returncode == 0:
                size = os.path.getsize(clip_path) / 1e6
                clips.append({'name': clip_name, 'path': clip_path, 'size_mb': round(size, 1), 'index': i+1})
                log(jid, f'✓ clip_{str(i+1).zfill(2)}.mp4 ({size:.1f} MB)')
            else:
                log(jid, f'✗ Error on clip {i+1}: {result.stderr[:100]}')

        finish(jid, {'clips': clips, 'clips_dir': CLIPS_DIR, 'total': len(clips)})
        log(jid, f'✓ Done! {len(clips)} clips extracted.')

    threading.Thread(target=run, daemon=True).start()
    return jsonify({'job_id': jid})

# ── VOICEOVER (ElevenLabs) ────────────────
@app.route('/voiceover', methods=['POST'])
def generate_voiceover():
    data       = request.json
    script     = data.get('script', '')
    voice_id   = data.get('voice_id', 'pNInz6obpgDQGcFmaJgB')  # Adam default
    api_key    = data.get('elevenlabs_key', '')
    stability  = data.get('stability', 0.6)
    similarity = data.get('similarity', 0.75)

    if not api_key:
        return jsonify({'error': 'ElevenLabs API key required'}), 400
    if not script:
        return jsonify({'error': 'Script is empty'}), 400

    jid = new_job('voiceover')

    def run():
        log(jid, 'Connecting to ElevenLabs API...')
        jobs[jid]['progress'] = 20

        url = f'https://api.elevenlabs.io/v1/text-to-speech/{voice_id}'
        headers = {
            'xi-api-key': api_key,
            'Content-Type': 'application/json',
            'Accept': 'audio/mpeg'
        }
        payload = {
            'text': script,
            'model_id': 'eleven_monolingual_v1',
            'voice_settings': {
                'stability': stability,
                'similarity_boost': similarity
            }
        }

        log(jid, f'Sending {len(script)} chars to TTS engine...')
        jobs[jid]['progress'] = 40

        try:
            response = requests.post(url, json=payload, headers=headers, stream=True)
            if response.status_code != 200:
                finish(jid, error=f'ElevenLabs error: {response.status_code} {response.text[:200]}')
                return

            audio_path = os.path.join(AUDIO_DIR, 'voiceover.mp3')
            with open(audio_path, 'wb') as f:
                for chunk in response.iter_content(chunk_size=8192):
                    f.write(chunk)

            jobs[jid]['progress'] = 90
            size_mb = os.path.getsize(audio_path) / 1e6

            # Get duration
            dur_result = subprocess.run([
                'ffprobe', '-v', 'quiet', '-show_entries', 'format=duration',
                '-of', 'csv=p=0', audio_path
            ], capture_output=True, text=True)
            duration = float(dur_result.stdout.strip() or 0)

            log(jid, f'✓ Voiceover: {duration:.0f}s · {size_mb:.1f}MB')
            finish(jid, {
                'audio_path': audio_path,
                'duration': duration,
                'size_mb': round(size_mb, 1),
                'duration_fmt': f'{int(duration//60):02d}:{int(duration%60):02d}'
            })
        except Exception as ex:
            finish(jid, error=str(ex))

    threading.Thread(target=run, daemon=True).start()
    return jsonify({'job_id': jid})

# ── FINAL RENDER ──────────────────────────
@app.route('/render', methods=['POST'])
def final_render():
    data        = request.json
    clips_dir   = data.get('clips_dir', CLIPS_DIR)
    audio_path  = data.get('audio_path', os.path.join(AUDIO_DIR, 'voiceover.mp3'))
    music_vol   = data.get('music_volume', 0.15)
    transition  = data.get('transition', 'crossfade')
    codec       = data.get('codec', 'h264')
    crf         = data.get('crf', 23)
    output_name = data.get('output_name', 'recap_final.mp4')

    jid = new_job('final_render')

    def run():
        log(jid, 'Starting final render...')
        jobs[jid]['progress'] = 5

        # Get all clips sorted
        clips = sorted([
            os.path.join(clips_dir, f)
            for f in os.listdir(clips_dir)
            if f.endswith('.mp4')
        ])

        if not clips:
            finish(jid, error='No clips found in clips directory')
            return

        log(jid, f'Found {len(clips)} clips to merge')
        jobs[jid]['progress'] = 10

        # Build concat list
        concat_file = os.path.join(BASE_DIR, 'concat.txt')
        with open(concat_file, 'w') as f:
            for clip in clips:
                f.write(f"file '{clip}'\n")

        # Step 1: Concatenate clips
        merged_video = os.path.join(BASE_DIR, 'merged.mp4')
        log(jid, 'Merging video clips...')
        subprocess.run([
            'ffmpeg', '-y', '-f', 'concat', '-safe', '0',
            '-i', concat_file,
            '-c', 'copy',
            merged_video
        ], capture_output=True)
        jobs[jid]['progress'] = 35
        log(jid, '✓ Clips merged')

        # Step 2: Mix voiceover + render
        output_path = os.path.join(OUTPUT_DIR, output_name)

        has_audio = os.path.exists(audio_path)
        log(jid, f'Mixing voiceover: {"yes" if has_audio else "no"}')

        if has_audio:
            cmd = [
                'ffmpeg', '-y',
                '-i', merged_video,
                '-i', audio_path,
                '-filter_complex',
                f'[0:a]volume=0.1[va];[1:a]volume=1.0[vo];[va][vo]amix=inputs=2:duration=shortest[aout]',
                '-map', '0:v',
                '-map', '[aout]',
                '-c:v', 'libx264',
                '-preset', 'medium',
                '-crf', str(crf),
                '-c:a', 'aac', '-b:a', '192k',
                '-shortest',
                output_path
            ]
        else:
            cmd = [
                'ffmpeg', '-y',
                '-i', merged_video,
                '-c:v', 'libx264',
                '-preset', 'medium',
                '-crf', str(crf),
                '-c:a', 'aac',
                output_path
            ]

        jobs[jid]['progress'] = 40
        log(jid, 'Encoding final video (this may take a few minutes)...')

        proc = subprocess.Popen(cmd, capture_output=True, text=True)

        # Simulate progress during encoding
        for p in range(40, 90, 5):
            if proc.poll() is not None: break
            time.sleep(3)
            jobs[jid]['progress'] = p
            log(jid, f'Encoding... {p}%')

        proc.wait()
        jobs[jid]['progress'] = 95

        if proc.returncode == 0 and os.path.exists(output_path):
            size_mb = os.path.getsize(output_path) / 1e6

            # Get final duration
            dur = subprocess.run([
                'ffprobe', '-v', 'quiet', '-show_entries', 'format=duration',
                '-of', 'csv=p=0', output_path
            ], capture_output=True, text=True)
            duration = float(dur.stdout.strip() or 0)

            log(jid, f'✓ Render complete! {output_name} · {size_mb:.0f}MB · {duration:.0f}s')
            finish(jid, {
                'output_path': output_path,
                'output_name': output_name,
                'size_mb': round(size_mb, 1),
                'duration': duration,
                'duration_fmt': f'{int(duration//60):02d}:{int(duration%60):02d}',
                'download_url': f'/download/{output_name}'
            })
        else:
            finish(jid, error=f'Render failed: {proc.stderr[-300:]}')

    threading.Thread(target=run, daemon=True).start()
    return jsonify({'job_id': jid})

# ── DOWNLOAD OUTPUT ───────────────────────
@app.route('/download/<filename>')
def download(filename):
    path = os.path.join(OUTPUT_DIR, filename)
    if os.path.exists(path):
        return send_file(path, as_attachment=True)
    return jsonify({'error': 'File not found'}), 404

# ── STATUS ────────────────────────────────
@app.route('/status')
def status():
    output_files = []
    if os.path.exists(OUTPUT_DIR):
        for f in os.listdir(OUTPUT_DIR):
            fp = os.path.join(OUTPUT_DIR, f)
            output_files.append({
                'name': f,
                'size_mb': round(os.path.getsize(fp) / 1e6, 1),
                'modified': time.ctime(os.path.getmtime(fp))
            })
    return jsonify({
        'status': 'running',
        'dirs': {
            'uploads': UPLOAD_DIR,
            'clips': CLIPS_DIR,
            'audio': AUDIO_DIR,
            'output': OUTPUT_DIR
        },
        'output_files': output_files,
        'active_jobs': len([j for j in jobs.values() if j['status'] == 'running'])
    })

# ── CLEANUP ───────────────────────────────
@app.route('/cleanup', methods=['POST'])
def cleanup():
    import shutil
    for d in [CLIPS_DIR, UPLOAD_DIR, AUDIO_DIR]:
        shutil.rmtree(d, ignore_errors=True)
        os.makedirs(d, exist_ok=True)
    return jsonify({'status': 'cleaned'})

# ══════════════════════════════════════════
if __name__ == '__main__':
    print("""
╔═══════════════════════════════════════╗
║     CineRecap Studio — Backend        ║
║     Running on your Android phone     ║
╠═══════════════════════════════════════╣
║  API ready at: http://localhost:5000  ║
║  Open your app and set Backend URL    ║
╚═══════════════════════════════════════╝
    """)
    app.run(host='0.0.0.0', port=5000, debug=False, threaded=True)
