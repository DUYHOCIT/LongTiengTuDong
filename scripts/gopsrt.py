import os
import re
import sys

# Đặt encoding cho stdout (dự phòng)
if sys.platform == "win32":
    import codecs
    sys.stdout = codecs.getwriter("utf-8")(sys.stdout.detach())

RE_TIME_PATTERN = re.compile(r'(\d{2}:\d{2}:\d{2},\d{3})\s*-->\s*(\d{2}:\d{2}:\d{2},\d{3})')
RE_SUBTITLE_BLOCKS = re.compile(r'\n\s*\n')
RE_BRACKET_CONTENT = re.compile(r'\[.*?\]')  # Biểu thức chính quy để loại bỏ nội dung trong []

def time_to_ms(time_str):
    h, m, s = time_str.split(':')
    s, ms = s.split(',')
    return int(h) * 3600000 + int(m) * 60000 + int(s) * 1000 + int(ms)

def ms_to_time_str(ms):
    hours = ms // 3600000
    ms %= 3600000
    minutes = ms // 60000
    ms %= 60000
    seconds = ms // 1000
    ms %= 1000
    return f"{hours:02d}:{minutes:02d}:{seconds:02d},{ms:03d}"

def parse_subtitle(subtitle_file):
    print(f"Đang phân tích file phụ đề: {subtitle_file}")
    subtitles = []
    encodings = ['utf-8', 'latin1', 'cp1252', 'windows-1252', 'iso-8859-1']
    
    content = None
    for enc in encodings:
        try:
            with open(subtitle_file, 'r', encoding=enc) as file:
                content = file.read()
            print(f"Đọc file với encoding: {enc}")
            break
        except UnicodeDecodeError:
            continue
    
    if not content:
        raise ValueError(f"Không thể đọc file phụ đề với các encoding: {encodings}")
    
    subtitle_blocks = RE_SUBTITLE_BLOCKS.split(content.strip())
    
    for block in subtitle_blocks:
        lines = block.strip().split('\n')
        if len(lines) >= 3:
            index = lines[0]
            time_match = RE_TIME_PATTERN.match(lines[1])
            if time_match:
                start_time = time_match.group(1)
                end_time = time_match.group(2)
                text = ' '.join(lines[2:])
                # Loại bỏ các định dạng không mong muốn
                text = re.sub(r'<[^>]+>', '', text)  # Loại bỏ thẻ HTML
                text = re.sub(r'\{[^}]+\}', '', text)  # Loại bỏ định dạng khác
                text = re.sub(RE_BRACKET_CONTENT, '', text)  # Loại bỏ nội dung trong []
                text = text.strip()
                if text:  # Chỉ thêm nếu văn bản không rỗng
                    subtitles.append({
                        'index': index,
                        'start_time': start_time,
                        'end_time': end_time,
                        'text': text
                    })
    
    print(f"Đã phân tích {len(subtitles)} đoạn phụ đề")
    return subtitles

def detect_continuous_segments(subtitles, max_segment_size=6):
    segments = []
    current_segment = []
    
    for i, subtitle in enumerate(subtitles):
        if not subtitle['text']:
            continue
        
        # Nếu là đoạn đầu tiên hoặc có khoảng trống với đoạn trước
        if not current_segment or (i > 0 and time_to_ms(subtitle['start_time']) > time_to_ms(subtitles[i-1]['end_time'])):
            if current_segment:  # Đóng nhóm trước nếu có
                segments.append(current_segment)
            current_segment = [subtitle]  # Bắt đầu nhóm mới
        else:
            # Nếu liên tục về thời gian, thêm vào nhóm hiện tại
            if len(current_segment) < max_segment_size:
                current_segment.append(subtitle)
            else:
                segments.append(current_segment)
                current_segment = [subtitle]
    
    if current_segment:  # Đóng nhóm cuối cùng
        segments.append(current_segment)
    
    return segments

def merge_segment(segment):
    if not segment:
        return None
    
    start_time = segment[0]['start_time']
    end_time = segment[-1]['end_time']
    texts = [s['text'] for s in segment]
    
    combined_text = ' '.join(texts)
    return {
        'start_time': start_time,
        'end_time': end_time,
        'text': combined_text
    }

def save_merged_subtitles(merged_segments, output_file):
    with open(output_file, 'w', encoding='utf-8') as f:
        for i, segment in enumerate(merged_segments):
            f.write(f"{i+1}\n")
            f.write(f"{segment['start_time']} --> {segment['end_time']}\n")
            f.write(f"{segment['text']}\n\n")

if __name__ == "__main__":
    if len(sys.argv) < 3:
        print("Usage: python gopsrt.py <input_srt_file> <output_srt_file>")
        sys.exit(1)
    
    subtitle_file = sys.argv[1]
    output_file = sys.argv[2]
    
    if not os.path.exists(subtitle_file):
        print(f"File không tồn tại: {subtitle_file}")
        sys.exit(1)
    
    try:
        subtitles = parse_subtitle(subtitle_file)
        if not subtitles:
            print("Không có phụ đề hợp lệ!")
            sys.exit(1)
        
        segments = detect_continuous_segments(subtitles, max_segment_size=10)
        merged_segments = [merge_segment(seg) for seg in segments if seg]
        merged_segments = [seg for seg in merged_segments if seg]
        
        save_merged_subtitles(merged_segments, output_file)
        print(f"Đã lưu phụ đề gộp tại: {output_file}")
    except Exception as e:
        print(f"Lỗi: {str(e)}")
        sys.exit(1)