import pandas as pd
from bs4 import BeautifulSoup
import re

def extract_from_view_source(html_file_path, table_id):
    print(f"Chargement du fichier {html_file_path}...")
    try:
        with open(html_file_path, 'r', encoding='utf-8') as f:
            view_source_soup = BeautifulSoup(f.read(), 'html.parser')
    except FileNotFoundError:
        print(f"Erreur : Le fichier {html_file_path} n'a pas été trouvé.")
        return None

    # Reconstruction du HTML d'origine à partir du rendu 'view-source'
    lines = [td.text for td in view_source_soup.find_all('td', class_='line-content')]
    original_html = '\n'.join(lines)
    soup = BeautifulSoup(original_html, 'html.parser')
    
    # Trouver la table
    table = soup.find('table', id=table_id)
    if not table:
        print(f"Erreur: Impossible de trouver la table '{table_id}' dans le fichier.")
        return None
        
    # Extraire les en-têtes
    headers = [th.text.strip() for th in table.find('thead').find_all('th')]
        
    # Extraire les lignes
    rows = []
    tbody = table.find('tbody')
    if tbody:
        for tr in tbody.find_all('tr'):
            cols = tr.find_all('td')
            if len(cols) > 0:
                row_data = [td.get('data-value') if td.get('data-value') is not None else td.text.strip() for td in cols]
                rows.append(row_data)
                
    df = pd.DataFrame(rows, columns=headers)
    return df.drop_duplicates()

def process_data(in_game_file, pledge_file, output_csv):
    df_ingame = extract_from_view_source(in_game_file, 'table-vehicles')
    df_pledge = extract_from_view_source(pledge_file, 'table-vehicles')

    if df_ingame is None or df_pledge is None:
        print("Erreur critique lors de l'extraction.")
        return

    # Nettoyage In-Game
    ingame_price_col = next((c for c in df_ingame.columns if 'price' in c.lower() or 'uec' in c.lower()), df_ingame.columns[2])
    seller_col = next((c for c in df_ingame.columns if 'seller' in c.lower() or 'location' in c.lower()), df_ingame.columns[1])
    df_ingame = df_ingame[['Name', seller_col, ingame_price_col]].copy()
    df_ingame.columns = ['Name', 'Location', 'aUEC_Price']
    df_ingame['aUEC_Price'] = pd.to_numeric(df_ingame['aUEC_Price'].astype(str).str.replace(r'[^0-9.]', '', regex=True), errors='coerce').fillna(0)

    # Nettoyage Pledge
    pledge_price_col = next((c for c in df_pledge.columns if 'price' in c.lower() or 'usd' in c.lower() or 'cost' in c.lower()), df_pledge.columns[1])
    df_pledge = df_pledge[['Name', pledge_price_col]].copy()
    df_pledge.columns = ['Name', 'Pledge_Price']
    df_pledge['Pledge_Price'] = pd.to_numeric(df_pledge['Pledge_Price'].astype(str).str.replace(r'[^0-9.]', '', regex=True), errors='coerce').fillna(0)

    # Fusion
    df_merged = pd.merge(df_ingame, df_pledge, on='Name', how='outer')
    df_merged['Pledge_Price'] = df_merged['Pledge_Price'].fillna(0)
    df_merged['aUEC_Price'] = df_merged['aUEC_Price'].fillna(0)
    df_merged['Location'] = df_merged['Location'].fillna('Boutique Pledge Uniquement')

    # Calcul ratio
    def get_ratio(row):
        a, p = float(row['aUEC_Price']), float(row['Pledge_Price'])
        if a == 0 and p == 0: return -2.0
        if a == 0: return -1.0
        if p == 0: return 0.0
        return round(a / p, 2)

    df_merged['aUEC/$'] = df_merged.apply(get_ratio, axis=1)
    
    df_merged.rename(columns={'Name': 'Vaisseau', 'Location': 'Lieu', 'aUEC_Price': 'Prix aUEC', 'Pledge_Price': 'Prix Pledge ($)'}, inplace=True)
    df_merged.to_csv(output_csv, index=False, sep=';', encoding='utf-8-sig')
    print(f"\nSuccès ! Fichier '{output_csv}' généré.")

if __name__ == "__main__":
    process_data("view-source_https___uexcorp.space_vehicles_home_list_in_game_sell_.html", 
                 "view-source_https___uexcorp.space_vehicles_home_list_pledge_store_.html", 
                 "Star_Citizen_Comparatif_Final.csv")