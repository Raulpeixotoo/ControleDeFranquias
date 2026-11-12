"""Gera o ZIP de código para upload manual no GitHub. Usa lista explícita."""
from pathlib import Path
import zipfile

ROOT = Path(__file__).resolve().parent
FILES = ["app.py", "database.py", "importer.py", "pipeline.py", "masters.py", "requirements.txt",
         "render.yaml", ".gitignore", ".env.example", "iniciar.bat", "migrar_para_neon.py",
         "migrar_para_neon.bat", "preparar_upload.py", "LEIA-ME-ONLINE.md"]


def main():
    files = [ROOT / name for name in FILES]
    files += sorted((ROOT / "static").glob("*"))
    files += sorted((ROOT / "tests").glob("*.py"))
    files += [ROOT / "tests" / "README.md", ROOT / "tests" / "ui_smoke.mjs"]
    files = [p for p in files if p.is_file()]
    if any(not (ROOT / name).is_file() for name in FILES):
        raise RuntimeError("Faltam arquivos da entrega; pacote não gerado.")
    folder = ROOT / "entrega"
    folder.mkdir(exist_ok=True)
    target = folder / "controle-urgencias-github.zip"
    with zipfile.ZipFile(target, "w", zipfile.ZIP_DEFLATED) as archive:
        for file in files:
            if file.suffix.lower() in (".db", ".xlsx", ".csv", ".zip") or file.name == ".env":
                raise RuntimeError("Arquivo de dados não permitido no pacote.")
            archive.write(file, file.relative_to(ROOT).as_posix())
    with zipfile.ZipFile(target) as archive:
        if archive.testzip() is not None:
            raise RuntimeError("Falha de integridade no ZIP.")
    print(f"Pacote pronto: {target}")
    print(f"{len(files)} arquivos; {target.stat().st_size / 1024:.0f} KB. Sem banco, planilhas, uploads ou credenciais reais.")
    print("Extraia o ZIP e envie o conteúdo ao GitHub; não envie apenas o arquivo ZIP.")


if __name__ == "__main__":
    main()
