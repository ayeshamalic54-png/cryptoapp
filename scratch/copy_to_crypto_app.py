import os
import shutil

src_dir = r"d:\google antigravity\jane_street_trading_system\trading\bot"
dst_dir = r"d:\google antigravity\Crypto_App"

exclude_dirs = {
    ".git",
    "node_modules",
    "__pycache__",
    ".local",
    ".replit",
    "dist",
    ".cache",
    ".expo"
}

exclude_files = {
    "Street-Trade-Executer (1).zip",
    "db_backup.json",
    "ml_model.joblib"
}

def copy_project(src, dst):
    for root, dirs, files in os.walk(src):
        # Filter directories to exclude
        dirs[:] = [d for d in dirs if d not in exclude_dirs]
        
        # Calculate relative path
        rel_path = os.path.relpath(root, src)
        dest_path = dst if rel_path == "." else os.path.join(dst, rel_path)
        
        if not os.path.exists(dest_path):
            os.makedirs(dest_path)
            
        for file in files:
            if file in exclude_files:
                continue
            if file.endswith(".zip") or file.endswith(".exe") or file.endswith(".pyc"):
                continue
                
            src_file = os.path.join(root, file)
            dst_file = os.path.join(dest_path, file)
            
            shutil.copy2(src_file, dst_file)
            print(f"Copied: {os.path.join(rel_path, file) if rel_path != '.' else file}")

if __name__ == "__main__":
    print(f"Copying project from {src_dir} to {dst_dir}...")
    copy_project(src_dir, dst_dir)
    print("Project copy completed successfully!")
