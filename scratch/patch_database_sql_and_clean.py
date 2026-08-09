import os

db_path = os.path.join(os.path.dirname(__file__), "..", "database.py")

with open(db_path, "r", encoding="utf-8") as f:
    content = f.read()

# 1. Update ON CONFLICT in update_daily_metrics
old_on_conflict = """        ON CONFLICT (trading_date) DO UPDATE
        SET current_equity = EXCLUDED.current_equity,"""

new_on_conflict = """        ON CONFLICT (trading_date) DO UPDATE
        SET start_equity = EXCLUDED.start_equity,
            current_equity = EXCLUDED.current_equity,"""

if old_on_conflict in content:
    content = content.replace(old_on_conflict, new_on_conflict)
    print("update_daily_metrics ON CONFLICT SQL successfully updated.")
else:
    print("old_on_conflict target not found in database.py!")

# 2. Remove the risk_safeguards cache update from reset_database_metrics_for_new_account
old_cache_update = """    # Also invalidate the local safeguards caches
    try:
        import risk_safeguards
        risk_safeguards._cached_start_equity = float(equity)
        risk_safeguards._cached_start_equity_date = today
        risk_safeguards._cached_last_login = int(login_id)
    except Exception as ex:
        print(f"Error updating risk_safeguards cache: {ex}")"""

if old_cache_update in content:
    content = content.replace(old_cache_update, "")
    print("risk_safeguards cache update removed from database.py.")
else:
    print("old_cache_update target not found in database.py!")

with open(db_path, "w", encoding="utf-8") as f:
    f.write(content)
print("File updated.")
