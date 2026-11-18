"""朋友圈配图去水印：底边如果识别出文字（微博/知乎角标、素材编号），切掉最下面一截再存。

用法：python photo_clean.py <输入图> <输出图>
输出一行 JSON：{"cropped": true|false, "text": "识别到的底边文字"}
失败时以非 0 退出，调用方保留原图。
"""
import asyncio
import ctypes
import io
import json
import sys
import threading

from PIL import Image


def _run_off_main_thread(factory, timeout):
    box = {}

    def worker():
        try:
            ctypes.windll.ole32.CoInitializeEx(None, 0)
            box['value'] = asyncio.run(asyncio.wait_for(factory(), timeout))
        except BaseException as exc:  # 交回调用方决定怎么报错
            box['error'] = exc

    thread = threading.Thread(target=worker, name='photo-clean', daemon=True)
    thread.start()
    thread.join(timeout + 2)
    if thread.is_alive():
        raise RuntimeError('ocr timeout')
    if 'error' in box:
        raise box['error']
    return box.get('value')


def ocr_text(image):
    from winsdk.windows.media.ocr import OcrEngine
    from winsdk.windows.graphics.imaging import BitmapDecoder
    from winsdk.windows.storage.streams import DataWriter, InMemoryRandomAccessStream

    png = io.BytesIO()
    image.save(png, format='PNG')
    data = png.getvalue()

    async def run():
        stream = InMemoryRandomAccessStream()
        try:
            writer = DataWriter(stream)
            try:
                writer.write_bytes(data)
                await writer.store_async()
                writer.detach_stream()
            finally:
                writer.close()
            stream.seek(0)
            decoder = await BitmapDecoder.create_async(stream)
            bitmap = await decoder.get_software_bitmap_async()
            try:
                engine = OcrEngine.try_create_from_user_profile_languages()
                if engine is None:
                    return ''
                result = await engine.recognize_async(bitmap)
                return ''.join(''.join(line.text.split()) for line in result.lines)
            finally:
                bitmap.close()
        finally:
            stream.close()

    return _run_off_main_thread(run, 6)


def main():
    src, dst = sys.argv[1], sys.argv[2]
    img = Image.open(src)
    img.load()
    img = img.convert('RGB')
    width, height = img.size
    strip = img.crop((0, int(height * 0.78), width, height))
    text = ''
    try:
        text = ocr_text(strip)
    except Exception:
        text = ''
    cropped = False
    # 微博/知乎的角标常压在底边、字号又小，OCR 未必认得出来；
    # 所以底边一律切掉一小截，认得出字就多切一点。
    ratio = 0.90 if text.strip() else 0.955
    keep = int(height * ratio)
    if keep > 200:
        img = img.crop((0, 0, width, keep))
        cropped = True
    img.save(dst, quality=92)
    print(json.dumps({'cropped': cropped, 'text': text[:40]}, ensure_ascii=False))


if __name__ == '__main__':
    main()
