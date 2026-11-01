"""Write the literature review draft and reference list to a Word file.
Input: JSON file with keys: title, style, draft, references (list of {text}), log (optional).
Citation markers {{cite:KEY}} are replaced with (Author, Year)-style labels only when the caller
provides a label map; otherwise the markers are removed so no raw keys reach the document.
Usage: python3 export_docx.py input.json output.docx
"""
import json, re, sys
from docx import Document
from docx.shared import Pt

def strip_markers(text, labels):
    def repl(m):
        return labels.get(m.group(1).strip(), '')
    return re.sub(r'\{\{cite:([^}]+)\}\}', repl, text)

def build(data, out_path):
    doc = Document()
    style = doc.styles['Normal']; style.font.name = 'Times New Roman'; style.font.size = Pt(12)
    doc.add_heading(data.get('title') or 'Literature review (draft)', level=1)
    p = doc.add_paragraph('AI-assisted draft. Every claim must be checked by the author before use.')
    p.runs[0].italic = True
    for para in str(data.get('draft', '')).split('\n'):
        if not para.strip():
            continue
        if para.startswith('#'):
            doc.add_heading(para.lstrip('#').strip(), level=2)
        else:
            doc.add_paragraph(strip_markers(para, data.get('labels', {})))
    doc.add_heading('References', level=1)
    for ref in data.get('references', []):
        doc.add_paragraph(ref['text'])
    doc.save(out_path)

if __name__ == '__main__':
    with open(sys.argv[1], encoding='utf-8') as f:
        build(json.load(f), sys.argv[2])
    print('written', sys.argv[2])
