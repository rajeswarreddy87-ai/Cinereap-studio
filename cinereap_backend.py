#!/usr/bin/env python3
"""
CineRecap Studio — Termux / VPS Backend
=======================================
Run on Android (Termux) or a VPS with FFmpeg installed.

SETUP (run once in Termux):
  pkg update && pkg upgrade -y
  pkg install python ffmpeg -y
  pip install flask flask-cors requests

RUN:
  python cinereap_backend.py
"""

from flask import Flask, request, jsonify, send_file
from flask_cors import CORS
import subprocess, os, json, requests, threading, uuid, time, re, shutil

app = Flask(__name__)
CORS(app)

# ── Directories ──────────────────────────
BASE_DIR = os.path.expanduser('~/cinereap')
UPLOAD_DIR = os.path.join(BASE_DIR, 'uploads')
CLIPS_DIR  = os.path.join(BASE_DIR, 'clips')
OUTPUT_DIR = os.path.join(BASE_DIR, 'output')
AUDIO_DIR  = os.path.join(BASE_DIR, 'audio')
SYNC_DIR   = os.path.join(BASE_DIR, 'sync_segments')

for d in [UPLOAD_DIR, CLIPS_DIR, OUTPUT_DIR, AUDIO_DIR, SYNC_DIR]:
    os.makedirs(d, exist_ok=True)

# Sync tuning — professional recap channels stay within this range
MIN_SPEED = 0.75
MAX_SPEED = 1.35
TARGET_FPS = 24
TARGET_W, TARGET_H = 1920, 1080

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
    if error:
        jobs[jid]['error'] = error

def parse_timestamp(ts):
    """Convert HH:MM:SS, MM:SS, or seconds to float seconds."""
    if ts is None:
        return 0.0
    if isinstance(ts, (int, float)):
        return float(ts)
    s = str(ts).strip()
    if re.match(r'^\d+(\.\d+)?$', s):
        return float(s)
    parts = s.split(':')
    if len(parts) == 3:
        return int(parts[0]) * 3600 + int(parts[1]) * 60 + float(parts[2])
    if len(parts) == 2:
        return int(parts[0]) * 60 + float(parts[1])
    return 0.0

def probe_duration(path):
    if not path or not os.path.exists(path):
        return 0.0
    result = subprocess.run(
        ['ffprobe', '-v', 'quiet', '-show_entries', 'format=duration', '-of', 'csv=p=0', path],
        capture_output=True, text=True
    )
    try:
        return float(result.stdout.strip() or 0)
    except ValueError:
        return 0.0

def run_ffmpeg(cmd, jid=None, label='ffmpeg'):
    result = subprocess.run(cmd, capture_output=True, text=True)
    if result.returncode != 0 and jid:
        log(jid, f'✗ {label} failed: {result.stderr[-200:]}')
    return result

def scale_pad_filter():
    return (
        f'scale={TARGET_W}:{TARGET_H}:force_original_aspect_ratio=decrease,'
        f'pad={TARGET_W}:{TARGET_H}:(ow-iw)/2:(oh-ih)/2'
    )

def extract_clip(movie_path, start, end, clip_path, mode='precise', jid=None):
    """Extract a clip with frame-accurate seeking when possible."""
    ss = str(start)
    to = str(end)
    vf = scale_pad_filter()

    if mode == 'fast':
        cmd = ['ffmpeg', '-y', '-i', movie_path, '-ss', ss, '-to', to, '-vf', vf,
               '-c:v', 'libx264', '-preset', 'fast', '-crf', '20', '-an', '-r', str(TARGET_FPS), clip_path]
    elif mode == 'cinematic':
        cmd = ['ffmpeg', '-y', '-i', movie_path, '-ss', ss, '-to', to,
               '-vf', vf + ',vignette', '-c:v', 'libx264', '-preset', 'fast', '-crf', '20',
               '-an', '-r', str(TARGET_FPS), clip_path]
    else:
        cmd = ['ffmpeg', '-y', '-i', movie_path, '-ss', ss, '-to', to, '-vf', vf,
               '-c:v', 'libx264', '-preset', 'fast', '-crf', '20', '-an', '-r', str(TARGET_FPS), clip_path]

    return run_ffmpeg(cmd, jid, f'clip {os.path.basename(clip_path)}').returncode == 0

def clamp_speed_ratio(video_dur, audio_dur):
    """Compute PTS ratio to match video length to audio length."""
    if video_dur <= 0 or audio_dur <= 0:
        return 1.0
    ratio = video_dur / audio_dur
    return max(MIN_SPEED, min(MAX_SPEED, ratio))

def sync_segment_video_to_audio(video_path, audio_path, output_path, jid=None):
    """
    Time-stretch video to match narration audio, then mux.
    This is the core professional-sync primitive used by recap channels.
    """
    video_dur = probe_duration(video_path)
    audio_dur = probe_duration(audio_path)
    ratio = clamp_speed_ratio(video_dur, audio_dur)

    if jid:
        log(jid, f'  sync: video={video_dur:.2f}s audio={audio_dur:.2f}s ratio={ratio:.3f}')

    vf = scale_pad_filter()
    filt = (
        f'[0:v]{vf},setpts=PTS/{ratio},fps={TARGET_FPS}[v];'
        f'[1:a]aformat=sample_rates=48000:channel_layouts=stereo,apad[a]'
    )

    cmd = [
        'ffmpeg', '-y', '-i', video_path, '-i', audio_path,
        '-filter_complex', filt,
        '-map', '[v]', '-map', '[a]',
        '-c:v', 'libx264', '-preset', 'fast', '-crf', '20',
        '-c:a', 'aac', '-b:a', '192k',
        '-shortest', '-avoid_negative_ts', 'make_zero',
        output_path
    ]
    return run_ffmpeg(cmd, jid, 'segment sync').returncode == 0

def elevenlabs_tts(text, voice_id, api_key, output_path, stability=0.6, similarity=0.75):
    if not text or not text.strip():
        return False, 'Empty text'
    url = f'https://api.elevenlabs.io/v1/text-to-speech/{voice_id}'
    headers = {'xi-api-key': api_key, 'Content-Type': 'application/json', 'Accept': 'audio/mpeg'}
    payload = {
        'text': text.strip(),
        'model_id': 'eleven_monolingual_v1',
        'voice_settings': {'stability': stability, 'similarity_boost': similarity}
    }
    try:
        response = requests.post(url, json=payload, headers=headers, timeout=120)
        if response.status_code != 200:
            return False, f'ElevenLabs {response.status_code}: {response.text[:200]}'
        with open(output_path, 'wb') as f:
            f.write(response.content)
        return True, None
    except Exception as ex:
        return False, str(ex)

def concat_segments(segment_paths, output_path, jid=None):
    concat_file = os.path.join(BASE_DIR, 'concat_sync.txt')
    with open(concat_file, 'w') as f:
        for p in segment_paths:
            f.write(f"file '{p}'\n")

    # Re-encode on concat for uniform codec/fps — avoids stream-copy drift
    cmd = [
        'ffmpeg', '-y', '-f', 'concat', '-safe', '0', '-i', concat_file,
        '-c:v', 'libx264', '-preset', 'medium', '-crf', '23',
        '-c:a', 'aac', '-b:a', '192k',
        '-r', str(TARGET_FPS),
        '-avoid_negative_ts', 'make_zero',
        output_path
    ]
    return run_ffmpeg(cmd, jid, 'concat').returncode == 0

def clear_dir(path):
    if os.path.isdir(path):
        shutil.rmtree(path, ignore_errors=True)
    os.makedirs(path, exist_ok=True)

# ══════════════════════════════════════════
#  ROUTES
# ══════════════════════════════════════════

@app.route('/ping')
def ping():
    return jsonify({
        'status': 'ok',
        'version': '2.0-sync',
        'message': 'CineRecap Backend with segment sync',
        'sync': True
    })

@app.route('/health')
def health():
    return jsonify({'ok': True, 'version': '2.0-sync', 'features': ['segment-sync', 'per-segment-tts']})

@app.route('/anthropic', methods=['POST'])
def anthropic_proxy():
    data = request.json
    api_key = data.get('api_key', '')
    prompt = data.get('prompt', '')
    model = data.get('model', 'claude-sonnet-4-20250514')
    max_tok = data.get('max_tokens', 4000)
    if not api_key:
        return jsonify({'error': 'No API key'}), 400
    try:
        r = requests.post(
            'https://api.anthropic.com/v1/messages',
            headers={'x-api-key': api_key, 'anthropic-version': '2023-06-01', 'Content-Type': 'application/json'},
            json={'model': model, 'max_tokens': max_tok, 'messages': [{'role': 'user', 'content': prompt}]},
            timeout=120
        )
        return jsonify(r.json()), r.status_code
    except Exception as e:
        return jsonify({'error': str(e)}), 500

@app.route('/elevenlabs', methods=['POST'])
def elevenlabs_proxy():
    data = request.json
    api_key = data.get('api_key', '')
    text = data.get('text', '')
    voice_id = data.get('voice_id', 'pNInz6obpgDQGcFmaJgB')
    stability = data.get('stability', 0.6)
    similarity = data.get('similarity', 0.75)
    if not api_key:
        return jsonify({'error': 'No API key'}), 400
    audio_path = os.path.join(AUDIO_DIR, 'voiceover.mp3')
    ok, err = elevenlabs_tts(text, voice_id, api_key, audio_path, stability, similarity)
    if not ok:
        return jsonify({'error': err}), 500
    duration = probe_duration(audio_path)
    return jsonify({
        'status': 'ok', 'audio_path': audio_path, 'duration': duration,
        'duration_fmt': f'{int(duration//60):02d}:{int(duration%60):02d}',
        'size_mb': round(os.path.getsize(audio_path) / 1e6, 1)
    })

@app.route('/job/<jid>')
def job_status(jid):
    return jsonify(jobs.get(jid, {'status': 'not_found'}))

@app.route('/upload', methods=['POST'])
def upload_movie():
    if 'file' not in request.files:
        return jsonify({'error': 'No file'}), 400
    f = request.files['file']
    filename = f'movie_{uuid.uuid4().hex[:8]}{os.path.splitext(f.filename)[1]}'
    path = os.path.join(UPLOAD_DIR, filename)
    f.save(path)

    result = subprocess.run(
        ['ffprobe', '-v', 'quiet', '-print_format', 'json', '-show_format', '-show_streams', path],
        capture_output=True, text=True
    )
    info = json.loads(result.stdout) if result.returncode == 0 else {}
    duration = float(info.get('format', {}).get('duration', 0))

    return jsonify({
        'filename': filename, 'path': path, 'duration': duration,
        'duration_fmt': f'{int(duration//3600):02d}:{int((duration%3600)//60):02d}:{int(duration%60):02d}',
        'size_mb': round(os.path.getsize(path) / 1e6, 1)
    })

@app.route('/clip', methods=['POST'])
def extract_clips():
    data = request.json
    movie_path = data.get('movie_path')
    timestamps = data.get('timestamps', [])
    mode = data.get('mode', 'precise')

    if not movie_path or not os.path.exists(movie_path):
        return jsonify({'error': 'Movie file not found'}), 400

    clear_dir(CLIPS_DIR)
    jid = new_job('clip_extraction')

    def run():
        clips = []
        total = len(timestamps)
        log(jid, f'Starting extraction of {total} clips (mode={mode})...')

        for i, ts in enumerate(timestamps):
            clip_name = f'clip_{str(i+1).zfill(2)}.mp4'
            clip_path = os.path.join(CLIPS_DIR, clip_name)
            jobs[jid]['progress'] = int((i / max(total, 1)) * 85)
            log(jid, f'Extracting clip {i+1}/{total}: {ts.get("start")} → {ts.get("end")}')

            if extract_clip(movie_path, ts['start'], ts['end'], clip_path, mode, jid):
                size = os.path.getsize(clip_path) / 1e6
                clips.append({
                    'name': clip_name, 'path': clip_path, 'size_mb': round(size, 1),
                    'index': i + 1, 'duration': probe_duration(clip_path),
                    'start': ts.get('start'), 'end': ts.get('end'), 'scene': ts.get('scene', '')
                })
                log(jid, f'✓ {clip_name} ({size:.1f} MB, {probe_duration(clip_path):.1f}s)')
            else:
                log(jid, f'✗ Error on clip {i+1}')

        finish(jid, {'clips': clips, 'clips_dir': CLIPS_DIR, 'total': len(clips)})
        log(jid, f'✓ Done! {len(clips)} clips extracted.')

    threading.Thread(target=run, daemon=True).start()
    return jsonify({'job_id': jid})

@app.route('/voiceover', methods=['POST'])
def generate_voiceover():
    """Legacy single-file voiceover (kept for compatibility)."""
    data = request.json
    script = data.get('script', '')
    voice_id = data.get('voice_id', 'pNInz6obpgDQGcFmaJgB')
    api_key = data.get('elevenlabs_key', '')
    stability = data.get('stability', 0.6)
    similarity = data.get('similarity', 0.75)
    segments = data.get('segments', [])

    if segments:
        return generate_voiceover_segments_internal(data)

    if not api_key:
        return jsonify({'error': 'ElevenLabs API key required'}), 400
    if not script:
        return jsonify({'error': 'Script is empty'}), 400

    jid = new_job('voiceover')

    def run():
        log(jid, 'Generating single voiceover file (legacy mode)...')
        jobs[jid]['progress'] = 40
        audio_path = os.path.join(AUDIO_DIR, 'voiceover.mp3')
        ok, err = elevenlabs_tts(script, voice_id, api_key, audio_path, stability, similarity)
        if not ok:
            finish(jid, error=err)
            return
        duration = probe_duration(audio_path)
        log(jid, f'✓ Voiceover: {duration:.0f}s')
        finish(jid, {
            'audio_path': audio_path, 'duration': duration,
            'size_mb': round(os.path.getsize(audio_path) / 1e6, 1),
            'duration_fmt': f'{int(duration//60):02d}:{int(duration%60):02d}',
            'mode': 'legacy'
        })

    threading.Thread(target=run, daemon=True).start()
    return jsonify({'job_id': jid})

def generate_voiceover_segments_internal(data):
    """Per-segment TTS — required for professional A/V sync."""
    segments = data.get('segments', [])
    voice_id = data.get('voice_id', 'pNInz6obpgDQGcFmaJgB')
    api_key = data.get('elevenlabs_key', '')
    stability = data.get('stability', 0.6)
    similarity = data.get('similarity', 0.75)

    if not api_key:
        return jsonify({'error': 'ElevenLabs API key required'}), 400
    if not segments:
        return jsonify({'error': 'segments array required'}), 400

    clear_dir(AUDIO_DIR)
    jid = new_job('voiceover_segments')

    def run():
        results = []
        total = len(segments)
        total_audio = 0.0
        log(jid, f'Generating {total} per-segment voiceovers for sync...')

        for i, seg in enumerate(segments):
            narration = seg.get('narration') or seg.get('text') or ''
            if not narration.strip():
                log(jid, f'⚠ Segment {i+1}: no narration text, skipping')
                continue

            audio_name = f'audio_{str(i+1).zfill(2)}.mp3'
            audio_path = os.path.join(AUDIO_DIR, audio_name)
            jobs[jid]['progress'] = int((i / max(total, 1)) * 90)
            log(jid, f'TTS segment {i+1}/{total}: {len(narration)} chars')

            ok, err = elevenlabs_tts(narration, voice_id, api_key, audio_path, stability, similarity)
            if not ok:
                log(jid, f'✗ Segment {i+1} failed: {err}')
                continue

            dur = probe_duration(audio_path)
            total_audio += dur
            results.append({
                'index': i + 1,
                'audio_path': audio_path,
                'duration': dur,
                'narration': narration[:80] + ('...' if len(narration) > 80 else ''),
                'start': seg.get('start'),
                'end': seg.get('end'),
                'scene': seg.get('scene', '')
            })
            log(jid, f'✓ audio_{str(i+1).zfill(2)}.mp3 = {dur:.2f}s')

        finish(jid, {
            'segments': results,
            'total_duration': total_audio,
            'duration_fmt': f'{int(total_audio//60):02d}:{int(total_audio%60):02d}',
            'mode': 'segments',
            'count': len(results)
        })
        log(jid, f'✓ {len(results)} segment voiceovers · total {total_audio:.1f}s')

    threading.Thread(target=run, daemon=True).start()
    return jsonify({'job_id': jid})

@app.route('/render', methods=['POST'])
def final_render():
    data = request.json
    sync_mode = data.get('sync_mode', True)
    segments = data.get('segments', [])
    movie_path = data.get('movie_path')
    clips_dir = data.get('clips_dir', CLIPS_DIR)
    audio_path = data.get('audio_path', os.path.join(AUDIO_DIR, 'voiceover.mp3'))
    mode = data.get('clip_mode', 'precise')
    crf = data.get('crf', 23)
    output_name = data.get('output_name', 'recap_final.mp4')
    music_path = data.get('music_path')
    music_volume = float(data.get('music_volume', 0.12))

    if sync_mode and segments and movie_path:
        return sync_render_internal(data)

    jid = new_job('final_render')

    def run_legacy():
        log(jid, 'Legacy render (no per-segment sync) — consider using sync_mode=true')
        jobs[jid]['progress'] = 5
        clips = sorted([os.path.join(clips_dir, f) for f in os.listdir(clips_dir) if f.endswith('.mp4')])
        if not clips:
            finish(jid, error='No clips found')
            return

        concat_file = os.path.join(BASE_DIR, 'concat.txt')
        with open(concat_file, 'w') as f:
            for clip in clips:
                f.write(f"file '{clip}'\n")

        merged_video = os.path.join(BASE_DIR, 'merged.mp4')
        run_ffmpeg(['ffmpeg', '-y', '-f', 'concat', '-safe', '0', '-i', concat_file,
                    '-c:v', 'libx264', '-preset', 'medium', '-crf', str(crf),
                    '-c:a', 'aac', '-r', str(TARGET_FPS), merged_video], jid)
        jobs[jid]['progress'] = 35

        output_path = os.path.join(OUTPUT_DIR, output_name)
        if os.path.exists(audio_path):
            cmd = [
                'ffmpeg', '-y', '-i', merged_video, '-i', audio_path,
                '-filter_complex',
                '[1:a]aformat=sample_rates=48000:channel_layouts=stereo[vo];[vo]apad[aout]',
                '-map', '0:v', '-map', '[aout]',
                '-c:v', 'copy', '-c:a', 'aac', '-b:a', '192k',
                '-shortest', output_path
            ]
        else:
            cmd = ['ffmpeg', '-y', '-i', merged_video, '-c', 'copy', output_path]

        proc = subprocess.Popen(cmd, capture_output=True, text=True)
        proc.wait()
        if proc.returncode == 0:
            duration = probe_duration(output_path)
            finish(jid, {'output_path': output_path, 'output_name': output_name,
                         'duration': duration, 'mode': 'legacy',
                         'download_url': f'/download/{output_name}'})
        else:
            finish(jid, error='Render failed')

    threading.Thread(target=run_legacy, daemon=True).start()
    return jsonify({'job_id': jid})

def sync_render_internal(data):
    """Professional sync pipeline: per-segment clip + TTS alignment."""
    segments = data.get('segments', [])
    movie_path = data.get('movie_path')
    mode = data.get('clip_mode', 'precise')
    crf = data.get('crf', 23)
    output_name = data.get('output_name', 'recap_final.mp4')
    music_path = data.get('music_path')
    music_volume = float(data.get('music_volume', 0.12))

    if not movie_path or not os.path.exists(movie_path):
        return jsonify({'error': 'movie_path not found'}), 400

    clear_dir(SYNC_DIR)
    jid = new_job('sync_render')

    def run():
        log(jid, '═══ SYNC RENDER: per-segment alignment ═══')
        synced_paths = []
        total = len(segments)
        total_video = 0.0
        total_audio = 0.0

        for i, seg in enumerate(segments):
            idx = seg.get('index', i + 1)
            audio_path = seg.get('audio_path')
            start = seg.get('start')
            end = seg.get('end')

            if not audio_path or not os.path.exists(audio_path):
                log(jid, f'⚠ Segment {idx}: missing audio, skipping')
                continue
            if not start or not end:
                log(jid, f'⚠ Segment {idx}: missing timestamps, skipping')
                continue

            jobs[jid]['progress'] = int((i / max(total, 1)) * 80)
            raw_clip = os.path.join(SYNC_DIR, f'raw_{str(idx).zfill(2)}.mp4')
            synced = os.path.join(SYNC_DIR, f'synced_{str(idx).zfill(2)}.mp4')

            log(jid, f'Segment {idx}/{total}: extract {start}→{end}')
            if not extract_clip(movie_path, start, end, raw_clip, mode, jid):
                continue

            audio_dur = probe_duration(audio_path)
            video_dur = probe_duration(raw_clip)
            log(jid, f'  aligning video {video_dur:.2f}s → audio {audio_dur:.2f}s')

            if not sync_segment_video_to_audio(raw_clip, audio_path, synced, jid):
                continue

            synced_dur = probe_duration(synced)
            synced_paths.append(synced)
            total_video += synced_dur
            total_audio += audio_dur
            log(jid, f'✓ synced_{str(idx).zfill(2)}.mp4 = {synced_dur:.2f}s')

        if not synced_paths:
            finish(jid, error='No synced segments produced')
            return

        jobs[jid]['progress'] = 85
        log(jid, f'Concatenating {len(synced_paths)} synced segments...')
        merged = os.path.join(SYNC_DIR, 'merged_synced.mp4')
        if not concat_segments(synced_paths, merged, jid):
            finish(jid, error='Concat failed')
            return

        output_path = os.path.join(OUTPUT_DIR, output_name)
        jobs[jid]['progress'] = 92

        if music_path and os.path.exists(music_path):
            log(jid, f'Mixing background music at {int(music_volume*100)}%')
            mv = music_volume
            filt = (
                f'[0:a]volume=1.0[vo];[1:a]volume={mv}[mu];'
                f'[vo][mu]amix=inputs=2:duration=first:dropout_transition=2[aout]'
            )
            cmd = [
                'ffmpeg', '-y', '-i', merged, '-i', music_path,
                '-filter_complex', filt,
                '-map', '0:v', '-map', '[aout]',
                '-c:v', 'copy', '-c:a', 'aac', '-b:a', '192k',
                '-shortest', output_path
            ]
        else:
            shutil.copy2(merged, output_path)

        duration = probe_duration(output_path)
        size_mb = round(os.path.getsize(output_path) / 1e6, 1)
        log(jid, f'✓ SYNC COMPLETE: {output_name} · {duration:.1f}s · {size_mb}MB')
        log(jid, f'  segments={len(synced_paths)} total_audio={total_audio:.1f}s')

        finish(jid, {
            'output_path': output_path,
            'output_name': output_name,
            'size_mb': size_mb,
            'duration': duration,
            'duration_fmt': f'{int(duration//60):02d}:{int(duration%60):02d}',
            'download_url': f'/download/{output_name}',
            'mode': 'sync',
            'segments_synced': len(synced_paths),
            'sync_report': {
                'total_audio_sec': round(total_audio, 2),
                'total_video_sec': round(total_video, 2),
                'drift_sec': round(abs(total_video - total_audio), 3)
            }
        })

    threading.Thread(target=run, daemon=True).start()
    return jsonify({'job_id': jid})

@app.route('/download/<filename>')
def download(filename):
    path = os.path.join(OUTPUT_DIR, filename)
    if os.path.exists(path):
        return send_file(path, as_attachment=True)
    return jsonify({'error': 'File not found'}), 404

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
        'version': '2.0-sync',
        'dirs': {'uploads': UPLOAD_DIR, 'clips': CLIPS_DIR, 'audio': AUDIO_DIR, 'output': OUTPUT_DIR, 'sync': SYNC_DIR},
        'output_files': output_files,
        'active_jobs': len([j for j in jobs.values() if j['status'] == 'running'])
    })

@app.route('/cleanup', methods=['POST'])
def cleanup():
    for d in [CLIPS_DIR, UPLOAD_DIR, AUDIO_DIR, SYNC_DIR]:
        clear_dir(d)
    return jsonify({'status': 'cleaned'})

if __name__ == '__main__':
    port = int(os.environ.get('PORT', 5000))
    print(f"""
╔═══════════════════════════════════════╗
║     CineRecap Studio — Backend        ║
║     v2.0 with Segment Sync            ║
╠═══════════════════════════════════════╣
║  API ready at: http://0.0.0.0:{port:<5} ║
╚═══════════════════════════════════════╝
    """)
    app.run(host='0.0.0.0', port=port, debug=False, threaded=True)
