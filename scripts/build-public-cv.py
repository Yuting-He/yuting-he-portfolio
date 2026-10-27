"""Build Yuting He's general public CV from verified portfolio material.

Sources: assets/Yuting_He_CV_MunichRe_AI_NatCat.docx (education,
experience and skills), index.html (current public experience/projects), and
README.md (HeatLens scope and limitations). Deliberately includes only the
public email, LinkedIn and GitHub contact details. No home address or phone.
The expected March 2027 M.Sc. graduation was confirmed directly by the user.

Requires ReportLab. Run: python scripts/build-public-cv.py
"""

from pathlib import Path
from xml.sax.saxutils import escape

import reportlab
from reportlab.lib import colors
from reportlab.lib.enums import TA_RIGHT
from reportlab.lib.pagesizes import A4
from reportlab.lib.styles import ParagraphStyle
from reportlab.pdfbase import pdfmetrics
from reportlab.pdfbase.ttfonts import TTFont
from reportlab.platypus import (
    HRFlowable, KeepTogether, PageBreak, Paragraph, SimpleDocTemplate,
    Spacer, Table, TableStyle,
)


ROOT = Path(__file__).resolve().parents[1]
OUTPUT = ROOT / "assets" / "Yuting_He_CV.pdf"
FONT_DIR = Path(reportlab.__file__).parent / "fonts"
pdfmetrics.registerFont(TTFont("CV", str(FONT_DIR / "Vera.ttf")))
pdfmetrics.registerFont(TTFont("CV-Bold", str(FONT_DIR / "VeraBd.ttf")))
pdfmetrics.registerFont(TTFont("CV-Italic", str(FONT_DIR / "VeraIt.ttf")))
pdfmetrics.registerFontFamily("CV", normal="CV", bold="CV-Bold", italic="CV-Italic", boldItalic="CV-Bold")

INK = colors.HexColor("#142B38")
TEAL = colors.HexColor("#00666B")
MUTED = colors.HexColor("#526572")
LINE = colors.HexColor("#D5DFE4")
PAGE_WIDTH, PAGE_HEIGHT = A4
MARGIN = 43
# SimpleDocTemplate's content frame has six-point inner padding on each side.
WIDTH = PAGE_WIDTH - 2 * MARGIN - 12

STYLES = {
    "name": ParagraphStyle("Name", fontName="CV-Bold", fontSize=28, leading=32, textColor=INK, spaceAfter=6),
    "tagline": ParagraphStyle("Tagline", fontName="CV", fontSize=10, leading=14, textColor=TEAL, spaceAfter=8),
    "contact": ParagraphStyle("Contact", fontName="CV", fontSize=8.4, leading=12, textColor=MUTED),
    "profile": ParagraphStyle("Profile", fontName="CV", fontSize=9.3, leading=13.4, textColor=INK, spaceAfter=10),
    "section": ParagraphStyle("Section", fontName="CV-Bold", fontSize=9.1, leading=12, textColor=TEAL, spaceBefore=9, spaceAfter=4),
    "title": ParagraphStyle("Title", fontName="CV-Bold", fontSize=10, leading=13.3, textColor=INK),
    "date": ParagraphStyle("Date", fontName="CV", fontSize=8.3, leading=13.3, textColor=MUTED, alignment=TA_RIGHT),
    "org": ParagraphStyle("Organization", fontName="CV", fontSize=9, leading=12.4, textColor=MUTED, spaceAfter=2),
    "body": ParagraphStyle("Body", fontName="CV", fontSize=9.2, leading=13, textColor=INK, spaceAfter=2),
    "bullet": ParagraphStyle("Bullet", fontName="CV", fontSize=9.2, leading=13, textColor=INK, leftIndent=10, bulletIndent=0, spaceAfter=2),
    "tools": ParagraphStyle("Tools", fontName="CV", fontSize=8.2, leading=11.7, textColor=MUTED, spaceAfter=3),
    "links": ParagraphStyle("Links", fontName="CV", fontSize=8.2, leading=11, textColor=TEAL, spaceAfter=3),
    "small_header": ParagraphStyle("SmallHeader", fontName="CV-Bold", fontSize=11, leading=15, textColor=INK, spaceAfter=2),
    "skill_label": ParagraphStyle("SkillLabel", fontName="CV-Bold", fontSize=8.9, leading=12.5, textColor=INK),
    "skill_body": ParagraphStyle("SkillBody", fontName="CV", fontSize=8.9, leading=12.5, textColor=INK),
}


def paragraph(text, kind="body"):
    return Paragraph(text, STYLES[kind])


def section(story, title):
    story.extend([
        paragraph(escape(title.upper()), "section"),
        HRFlowable(width="100%", thickness=0.55, color=LINE),
        Spacer(1, 6),
    ])


def entry(story, title, date, organization=None, points=(), description=None, tools=None, links=()):
    header = Table([[paragraph(escape(title), "title"), paragraph(escape(date), "date")]],
                   colWidths=[WIDTH - 132, 132])
    header.setStyle(TableStyle([
        ("LEFTPADDING", (0, 0), (-1, -1), 0), ("RIGHTPADDING", (0, 0), (-1, -1), 0),
        ("TOPPADDING", (0, 0), (-1, -1), 0), ("BOTTOMPADDING", (0, 0), (-1, -1), 1),
        ("VALIGN", (0, 0), (-1, -1), "TOP"),
    ]))
    content = [header]
    if organization:
        content.append(paragraph(escape(organization), "org"))
    if description:
        content.append(paragraph(escape(description)))
    content.extend(Paragraph(escape(point), STYLES["bullet"], bulletText="-") for point in points)
    if tools:
        content.append(paragraph(escape(tools), "tools"))
    if links:
        content.append(paragraph(" &nbsp; | &nbsp; ".join(
            f'<link href="{escape(url)}" color="#00666B">{escape(label)}</link>' for label, url in links
        ), "links"))
    content.append(Spacer(1, 7))
    story.append(KeepTogether(content))


def footer(canvas, doc):
    canvas.saveState()
    canvas.setStrokeColor(TEAL)
    canvas.setLineWidth(2)
    canvas.line(MARGIN, PAGE_HEIGHT - 25, PAGE_WIDTH - MARGIN, PAGE_HEIGHT - 25)
    canvas.setStrokeColor(LINE)
    canvas.setLineWidth(0.5)
    canvas.line(MARGIN, 32, PAGE_WIDTH - MARGIN, 32)
    canvas.setFont("CV", 7)
    canvas.setFillColor(MUTED)
    canvas.drawString(MARGIN, 21, "Yuting He | Public CV | October 2026")
    canvas.drawRightString(PAGE_WIDTH - MARGIN, 21, f"{doc.page} / 2")
    canvas.restoreState()


def build_cv(output=OUTPUT):
    output = Path(output)
    output.parent.mkdir(parents=True, exist_ok=True)
    doc = SimpleDocTemplate(str(output), pagesize=A4, leftMargin=MARGIN, rightMargin=MARGIN,
                            topMargin=38, bottomMargin=44,
                            title="Yuting He | Public Curriculum Vitae", author="Yuting He",
                            subject="Environmental engineering, statistics, geospatial risk and applied AI")
    story = [
        paragraph("YUTING HE", "name"),
        paragraph("Environmental Engineering | Statistics | GIS &amp; NatCat Risk | Applied AI", "tagline"),
        paragraph('<link href="mailto:yutingh19@gmail.com" color="#00666B">yutingh19@gmail.com</link>'
                  ' &nbsp; | &nbsp; <link href="https://www.linkedin.com/in/yuting-he-945473214/" color="#00666B">LinkedIn</link>'
                  ' &nbsp; | &nbsp; <link href="https://github.com/Yuting-He" color="#00666B">github.com/Yuting-He</link>', "contact"),
        Spacer(1, 10),
        paragraph("M.Sc. candidate in Environmental Engineering (expected March 2027), combining statistics with geospatial risk analytics, "
                  "applied machine learning and AI-assisted development. Experience spans reinsurance, hydrology research, "
                  "engineering teaching and transparent decision-support prototypes.", "profile"),
    ]

    section(story, "Education")
    entry(story, "M.Sc. Environmental Engineering - candidate", "Oct 2023 - expected Mar 2027",
          "Technical University of Munich (TUM)",
          description="Hydrology and water resources, environmental risk, uncertainty analysis and machine learning in forecasting.")
    entry(story, "B.Sc. Statistics; minor in Computer Science", "Oct 2020 - Feb 2025",
          "Ludwig Maximilian University of Munich (LMU)",
          description="Statistical modelling, machine learning, databases, algorithms and programming. Final grade: 1.89.")
    entry(story, "B.Sc. Environmental Engineering", "Oct 2018 - Jun 2023",
          "Technical University of Munich (TUM)",
          description="Water engineering, hydrology, hydraulics, wastewater systems, sustainable design and transportation systems.")

    section(story, "Professional experience")
    entry(story, "Intern - Hydrological Risk", "Nov 2025 - Aug 2026",
          "Munich Re - Geo Risk, Corporate Underwriting", points=[
              "Prepared and quality-checked geospatial flood hazard and exposure datasets for NatCat analysis.",
              "Built ArcPy/Python geoprocessing workflows and a MATLAB interface for hydrological risk analysis.",
              "Used Microsoft Copilot and LLM tools for recurring workflows and technical documentation.",
          ])
    entry(story, "Student Research Assistant - Machine Learning in Hydrology", "Apr 2025 - Aug 2025",
          "TUM - Chair of Hydrology and River Basin Management", points=[
              "Prepared Python/Google Colab teaching notebooks covering preprocessing, feature engineering, training and evaluation for hydrological forecasting.",
          ])
    entry(story, "Teaching Assistant - Hydromechanics", "Oct 2022 - Feb 2024",
          "TUM - Professorship of Hydromechanics", points=[
              "Led exercise sessions, explained quantitative fluid-mechanics solutions and prepared structured feedback on recurring mistakes.",
          ])
    entry(story, "Landscape Planning Assistant (full-time)", "Apr 2017 - Nov 2017",
          "Earthasia Design Group, China", points=[
              "Assisted residential, agricultural and commercial landscape planning, using AutoCAD, Adobe Photoshop/Illustrator and MS Office.",
          ])

    story.extend([PageBreak(), paragraph("YUTING HE", "small_header"),
                  paragraph("Selected projects and technical methods", "org")])
    section(story, "Selected projects")
    entry(story, "HeatLens Germany - Multi-Hazard Decision Translation", "2026", points=[
        "Built a Germany-wide GIS research application with 614 hydrological sub-basins, 400 district views and 16 state summaries, joined by exact area-overlap weights.",
        "Integrated DWD/ICON ensembles, RADOLAN observations, UFZ soil-moisture percentiles and DWD crop-specific soil-water context.",
        "Implemented role-specific checks, freshness gates, shareable views and English/German explanations. Scores are uncalibrated screening indices, not official warnings.",
    ], tools="JavaScript | Python | GIS | NetCDF/HDF5 | Automated data and browser checks", links=[
        ("Live demo", "https://yuting-he.github.io/yuting-he-portfolio/heatwave-demo.html"),
        ("Source", "https://github.com/Yuting-He/yuting-he-portfolio"),
    ])
    entry(story, "GridScout - Adaptive Power Grid Inspection", "Oct 2026", points=[
        "Developed a Bayesian decision-support prototype for adaptive drone inspection after extreme weather, using a 64-segment Bavaria grid map.",
        "Created a mission replay and auditable evidence dashboard with synthetic telemetry and visual-inspection evidence. Demonstration probabilities are uncalibrated.",
    ], tools="Python | Streamlit | NetworkX | Bayesian inference | JavaScript", links=[
        ("Public showcase", "https://yuting-he.github.io/yuting-he-portfolio/watt-hackathon/index.html"),
        ("Source", "https://github.com/Yuting-He/yuting-he-portfolio/tree/main/watt-hackathon"),
    ])
    entry(story, "Spatiotemporal Drought Prediction", "Mar 2025 - Jul 2025", points=[
        "Developed drought classification models from climate, soil, land-use and terrain features; compared LSTM, Transformer and GNN approaches with temporal and spatial validation.",
        "Extended the work with a CAMELS-DE Neckar catchment graph for one-month-ahead drought context.",
    ], tools="Python | PyTorch | scikit-learn | pandas | NumPy | GIS | Graph learning")
    entry(story, "Additional environmental and NGO prototypes", "Jun 2026", points=[
        "Forest degradation in Ethiopia: open geospatial visualization and a restoration-prioritization prototype for NGO scenarios.",
        "Impact Atlas: AI-assisted curation and ranking of news, reports, funding calls and field signals by NGO mission, region and topic.",
    ])

    section(story, "Technical toolkit")
    skills = [
        ("GIS and risk", "ArcGIS Pro, QGIS, ArcPy; raster/vector processing, exposure data checks, flood and drought analysis."),
        ("Programming", "Python, R, pandas, NumPy, scikit-learn, PyTorch basics, SQL, Java, basic C++, Git; JavaScript web prototypes."),
        ("Hydrology tools", "HEC-HMS, WaSiM, HYDRO-AS 2D, MODFLOW and MATLAB."),
        ("Reporting", "Excel, PowerPoint, LaTeX, matplotlib, seaborn, ggplot2, Power BI and Tableau."),
        ("AI-assisted work", "Microsoft Copilot, GitHub Copilot, ChatGPT, Claude and Codex for prototyping, debugging and documentation."),
    ]
    table = Table([[paragraph(escape(label), "skill_label"), paragraph(escape(body), "skill_body")]
                   for label, body in skills], colWidths=[104, WIDTH - 104])
    table.setStyle(TableStyle([
        ("LEFTPADDING", (0, 0), (-1, -1), 0), ("RIGHTPADDING", (0, 0), (-1, -1), 5),
        ("TOPPADDING", (0, 0), (-1, -1), 1), ("BOTTOMPADDING", (0, 0), (-1, -1), 4),
        ("VALIGN", (0, 0), (-1, -1), "TOP"),
    ]))
    story.append(table)
    section(story, "Languages")
    story.append(paragraph("Chinese - native | English - C1 | German - C1"))
    doc.build(story, onFirstPage=footer, onLaterPages=footer)
    return output


if __name__ == "__main__":
    print(build_cv())
