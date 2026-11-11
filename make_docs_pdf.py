# -*- coding: utf-8 -*-
# Сборка PDF-документации проекта ЖКС из Markdown (DEPLOY.md, DEPLOY-BEGET.md, ADMIN-GUIDE.md)
import os, re
from reportlab.lib.pagesizes import A4
from reportlab.lib.units import cm
from reportlab.lib.styles import ParagraphStyle
from reportlab.lib.colors import HexColor
from reportlab.pdfbase import pdfmetrics
from reportlab.pdfbase.ttfonts import TTFont
from reportlab.platypus import (BaseDocTemplate, PageTemplate, Frame, Paragraph, Spacer,
                                Table, TableStyle, PageBreak, Preformatted)
from reportlab.platypus.tableofcontents import TableOfContents

SRC = os.path.dirname(os.path.abspath(__file__))
OUT = os.path.join(SRC, 'Документация-ЖКС.pdf')
DOCS = [('DEPLOY.md', 'Развёртывание проекта'),
        ('DEPLOY-BEGET.md', 'Переезд на Beget VPS'),
        ('ADMIN-GUIDE.md', 'Инструкция по админке для сотрудников УК')]

# Шрифты Windows с кириллицей
F = r'C:\Windows\Fonts'
pdfmetrics.registerFont(TTFont('Body', f'{F}\\arial.ttf'))
pdfmetrics.registerFont(TTFont('Body-Bold', f'{F}\\arialbd.ttf'))
pdfmetrics.registerFont(TTFont('Mono', f'{F}\\consola.ttf'))
pdfmetrics.registerFont(TTFont('Mono-Bold', f'{F}\\consolab.ttf'))
pdfmetrics.registerFontFamily('Body', normal='Body', bold='Body-Bold', italic='Body', boldItalic='Body-Bold')

INK = HexColor('#1f2937'); MUT = HexColor('#6b7280'); ACC = HexColor('#1d4ed8')

S = {
 'Title':   ParagraphStyle('Title', fontName='Body-Bold', fontSize=24, leading=30, textColor=INK),
 'Sub':     ParagraphStyle('Sub', fontName='Body', fontSize=13, leading=18, textColor=MUT),
 'H1':      ParagraphStyle('H1', fontName='Body-Bold', fontSize=17, leading=22, textColor=INK, spaceBefore=18, spaceAfter=10, keepWithNext=1),
 'H2':      ParagraphStyle('H2', fontName='Body-Bold', fontSize=13.5, leading=18, textColor=ACC, spaceBefore=14, spaceAfter=6, keepWithNext=1),
 'H3':      ParagraphStyle('H3', fontName='Body-Bold', fontSize=11.5, leading=15, textColor=INK, spaceBefore=10, spaceAfter=4, keepWithNext=1),
 'Body':    ParagraphStyle('Body', fontName='Body', fontSize=10.5, leading=15.5, textColor=INK, spaceAfter=6),
 'Bullet':  ParagraphStyle('Bullet', fontName='Body', fontSize=10.5, leading=15.5, textColor=INK, leftIndent=16, bulletIndent=4, spaceAfter=3),
 'Code':    ParagraphStyle('Code', fontName='Mono', fontSize=8.5, leading=12, textColor=INK, backColor=HexColor('#f3f4f6'), borderPadding=8, spaceBefore=4, spaceAfter=8),
 'Cell':    ParagraphStyle('Cell', fontName='Body', fontSize=9.5, leading=13, textColor=INK),
 'CellB':   ParagraphStyle('CellB', fontName='Body-Bold', fontSize=9.5, leading=13, textColor=INK),
 'TOC1':    ParagraphStyle('TOC1', fontName='Body-Bold', fontSize=11, leading=20, textColor=INK),
 'TOC2':    ParagraphStyle('TOC2', fontName='Body', fontSize=10, leading=16, leftIndent=14, textColor=INK),
}

def inline(t):
    t = t.replace('&', '&amp;').replace('<', '&lt;').replace('>', '&gt;')
    t = re.sub(r'\[([^\]]+)\]\(([^)]+)\)', r'<a href="\2" color="#1d4ed8">\1</a>', t)
    t = re.sub(r'\*\*([^*]+)\*\*', r'<b>\1</b>', t)
    t = re.sub(r'`([^`]+)`', r'<font face="Mono" size="9">\1</font>', t)
    return t

def md_to_story(text, story, headings):
    lines = text.split('\n'); i = 0
    while i < len(lines):
        ln = lines[i]
        if ln.strip().startswith('```'):
            code = []; i += 1
            while i < len(lines) and not lines[i].strip().startswith('```'):
                code.append(lines[i]); i += 1
            i += 1
            story.append(Preformatted('\n'.join(code).replace('&','&amp;').replace('<','&lt;'), S['Code']))
            continue
        m = re.match(r'^(#{1,3})\s+(.*)', ln)
        if m:
            lvl, txt = len(m.group(1)), inline(m.group(2))
            if lvl == 1: story.append(Paragraph(txt, S['H1'])); headings.append((0, re.sub(r'<[^>]+>', '', txt)))
            elif lvl == 2: story.append(Paragraph(txt, S['H2'])); headings.append((1, re.sub(r'<[^>]+>', '', txt)))
            else: story.append(Paragraph(txt, S['H3']))
            i += 1; continue
        if ln.strip().startswith('|') and i + 1 < len(lines) and re.match(r'^\s*\|[\s\-|:]+\|\s*$', lines[i+1]):
            header = [c.strip() for c in ln.strip('|').split('|')]
            rows = [[Paragraph(inline(c), S['CellB']) for c in header]]; i += 2
            while i < len(lines) and lines[i].strip().startswith('|'):
                cells = [c.strip() for c in lines[i].strip().strip('|').split('|')]
                rows.append([Paragraph(inline(c), S['Cell']) for c in cells]); i += 1
            w = 16.5 * cm; ncol = len(header)
            t = Table(rows, colWidths=[w/ncol]*ncol)
            t.setStyle(TableStyle([
                ('LINEABOVE', (0,0), (-1,0), 1.2, INK),
                ('LINEBELOW', (0,0), (-1,0), 0.6, INK),
                ('LINEBELOW', (0,-1), (-1,-1), 1.2, INK),
                ('TOPPADDING', (0,0), (-1,-1), 5), ('BOTTOMPADDING', (0,0), (-1,-1), 5),
                ('LEFTPADDING', (0,0), (-1,-1), 4), ('RIGHTPADDING', (0,0), (-1,-1), 4),
                ('VALIGN', (0,0), (-1,-1), 'TOP'),
            ]))
            story.append(Spacer(1, 4)); story.append(t); story.append(Spacer(1, 8)); continue
        m = re.match(r'^\s*- \[([ xX])\]\s+(.*)', ln)
        if m:
            mark = '[x]' if m.group(1).lower() == 'x' else '[ ]'
            story.append(Paragraph(inline(m.group(2)), S['Bullet'], bulletText=mark)); i += 1; continue
        m = re.match(r'^\s*[-*]\s+(.*)', ln)
        if m:
            story.append(Paragraph(inline(m.group(1)), S['Bullet'], bulletText='•')); i += 1; continue
        m = re.match(r'^\s*(\d+)\.\s+(.*)', ln)
        if m:
            story.append(Paragraph(inline(m.group(2)), S['Bullet'], bulletText=m.group(1) + '.')); i += 1; continue
        if ln.strip():
            story.append(Paragraph(inline(ln.strip()), S['Body']))
        i += 1

class Doc(BaseDocTemplate):
    def afterFlowable(self, fl):
        if isinstance(fl, Paragraph):
            st = fl.style.name
            if st in ('H1', 'H2'):
                lvl = 0 if st == 'H1' else 1
                self.notify('TOCEntry', (lvl, fl.getPlainText(), self.page))

def header_footer(cv, doc):
    cv.saveState()
    w, h = A4
    cv.setFont('Body', 8); cv.setFillColor(MUT)
    cv.drawString(2.5*cm, h - 1.3*cm, 'Проект «ЖКС» — сайт УК «Жилкомсервис», Сосновоборск')
    cv.drawRightString(w - 2.5*cm, 1.4*cm, f'стр. {doc.page}')
    cv.setStrokeColor(HexColor('#e5e7eb')); cv.setLineWidth(0.5)
    cv.line(2.5*cm, h - 1.6*cm, w - 2.5*cm, h - 1.6*cm)
    cv.restoreState()

def first_page(cv, doc):
    cv.saveState()
    w, h = A4
    cv.setStrokeColor(ACC); cv.setLineWidth(3)
    cv.line(2.5*cm, h - 6.5*cm, w - 2.5*cm, h - 6.5*cm)
    cv.restoreState()

frame = Frame(2.5*cm, 2*cm, A4[0]-5*cm, A4[1]-4.2*cm, id='main')
doc = Doc(OUT, pagesize=A4, topMargin=2.2*cm, bottomMargin=2*cm, leftMargin=2.5*cm, rightMargin=2.5*cm)
doc.addPageTemplates([PageTemplate(id='p', frames=[frame], onPage=header_footer)])
doc.title = 'Документация проекта ЖКС'; doc.author = 'Проект ЖКС'

story = []
story.append(Spacer(1, 3.5*cm))
story.append(Paragraph('Документация проекта «ЖКС»', S['Title']))
story.append(Spacer(1, 10))
story.append(Paragraph('Новый сайт ООО УК «Жилкомсервис» (Сосновоборск) — развёртывание, переезд на Beget VPS, работа с админкой', S['Sub']))
story.append(Spacer(1, 20))
story.append(Paragraph('Версия от 11.11.2026 · репозиторий: github.com/nextangel-git/nextangel-git.github.io', S['Sub']))
story.append(PageBreak())
toc = TableOfContents(); toc.levelStyles = [S['TOC1'], S['TOC2']]
story.append(Paragraph('Содержание', S['H1']))
story.append(toc)
story.append(PageBreak())

for fname, _ in DOCS:
    with open(os.path.join(SRC, fname), encoding='utf-8') as f:
        text = f.read()
    md_to_story(text, story, [])
    story.append(PageBreak())

doc.multiBuild(story)
print('OK:', OUT, os.path.getsize(OUT), 'байт')
